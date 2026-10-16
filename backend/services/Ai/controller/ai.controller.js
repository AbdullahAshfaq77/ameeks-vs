import { randomUUID } from "crypto"
import { AIMessage, HumanMessage } from "@langchain/core/messages"
import { Command, GraphRecursionError } from "@langchain/langgraph"
import { graph, checkpointer, describeImage, isRateLimited } from "../graph/graph.js"
import { Image } from "../models/image.model.js"
import { embedImageText, findRelatedImages } from "../utils/imageRag.js"

// A chat turn is one "run" of the graph. It pauses at every tool call: the reply
// carries the calls to the browser, which runs them and posts the results to
// /chat/resume, until the model answers with text.
//
//   POST /chat         { projectId, message, history, attachments, context }
//   POST /chat/resume  { threadId, results: [{ id, output }] }
//   both reply         { status: "tool_calls", threadId, toolCalls: [{ id, name, args }] }
//                   or { status: "done", threadId, reply }

const MAX_HISTORY = 12
const MAX_TOOL_ROUNDS = 40
const MAX_ATTACHMENTS = 5
const MAX_ATTACHMENT_CHARS = 64 * 1024
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"])
// A browser that closes mid-run never resumes, so its paused run is dropped after this
const RUN_TTL_MS = 30 * 60 * 1000

// Paused runs by thread id: who owns them and the context each graph step needs
const runs = new Map()

const endRun = async (threadId) => {
  runs.delete(threadId)
  await checkpointer.deleteThread(threadId).catch(() => {})
}

setInterval(() => {
  const now = Date.now()
  for (const [threadId, run] of runs) {
    if (now - run.updatedAt > RUN_TTL_MS) endRun(threadId)
  }
}, 5 * 60 * 1000).unref()

// Earlier turns as plain text; tool steps of past turns are not replayed
const buildHistory = (history) => {
  if (!Array.isArray(history)) return []
  return history
    .filter((msg) => typeof msg?.content === "string" && msg.content.trim() && (msg.role === "user" || msg.role === "assistant"))
    .slice(-MAX_HISTORY)
    .map((msg) => msg.role === "user" ? new HumanMessage(msg.content) : new AIMessage(msg.content))
}

// Attached files are added to the message as fenced blocks
const withAttachments = (message, attachments) => {
  if (!Array.isArray(attachments) || !attachments.length) return message
  const blocks = attachments
    .filter((file) => typeof file?.name === "string" && typeof file?.content === "string")
    .slice(0, MAX_ATTACHMENTS)
    .map((file) => `Attached file "${file.name}":\n\`\`\`\n${file.content.slice(0, MAX_ATTACHMENT_CHARS)}\n\`\`\``)
  return [message, ...blocks].filter(Boolean).join("\n\n")
}

const textOf = (message) => {
  const content = message?.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map((part) => typeof part === "string" ? part : part?.text || "").join("")
  return ""
}

const cleanContext = (context = {}) => ({
  projectName: typeof context.projectName === "string" ? context.projectName.slice(0, 200) : undefined,
  folderName: typeof context.folderName === "string" ? context.folderName.slice(0, 200) : undefined,
  activeFile: typeof context.activeFile === "string" ? context.activeFile.slice(0, 500) : undefined,
})

// Advances a run until it pauses for tools or finishes, and sends the matching reply
const step = async (res, threadId, input) => {
  const run = runs.get(threadId)
  const config = {
    configurable: { thread_id: threadId, context: run.context },
    // Each tool round is two graph steps (agent, tools)
    recursionLimit: MAX_TOOL_ROUNDS * 2 + 5,
  }

  try {
    const result = await graph.invoke(input, config)
    const paused = result.__interrupt__?.[0]?.value
    if (paused?.toolCalls?.length) {
      run.updatedAt = Date.now()
      return res.json({ status: "tool_calls", threadId, toolCalls: paused.toolCalls })
    }

    await endRun(threadId)
    const reply = textOf(result.messages?.[result.messages.length - 1]).trim()
    return res.json({ status: "done", threadId, reply: reply || "Done." })
  } catch (error) {
    await endRun(threadId)
    if (error instanceof GraphRecursionError) {
      return res.json({
        status: "done",
        threadId,
        reply: `I stopped after ${MAX_TOOL_ROUNDS} tool steps without finishing. Tell me to continue, or narrow the task.`,
      })
    }
    if (isRateLimited(error)) {
      return res.status(429).json({
        message: error.dailyLimit
          ? "AmeekAi has used today's free AI quota on every model. It resets at midnight Pacific time; a paid Gemini API key removes the limit."
          : error.overloaded
            ? "The AI models are busy right now. Try again in a minute."
            : "AmeekAi hit the AI provider's rate limit. Wait a minute and try again.",
      })
    }
    console.error("AI run error:", error)
    return res.status(502).json({ message: "AmeekAi could not finish this request. Please try again." })
  }
}

export const chat = async (req, res) => {
  try {
    const { projectId, message, history = [], attachments = [], imageIds = [], context } = req.body || {}
    const userId = req.headers["x-user-id"]

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" })
    }
    if (typeof projectId !== "string" || !projectId.trim()) {
      return res.status(400).json({ message: "projectId is required" })
    }
    const normalizedProjectId = projectId.trim()
    if (!Array.isArray(attachments)) {
      return res.status(400).json({ message: "attachments must be an array" })
    }
    if (!Array.isArray(imageIds) || imageIds.some((id) => typeof id !== "string")) {
      return res.status(400).json({ message: "imageIds must be an array of image IDs" })
    }
    const text = typeof message === "string" ? message.trim() : ""
    if (!text && !attachments.length && !imageIds.length) {
      return res.status(400).json({ message: "message is required" })
    }

    const uniqueImageIds = [...new Set(imageIds)]
    const currentImages = uniqueImageIds.length
      ? await Image.find({ imageId: { $in: uniqueImageIds }, userId: String(userId), projectId: normalizedProjectId })
        .select("imageId name caption")
        .lean()
      : []
    if (currentImages.length !== uniqueImageIds.length) {
      return res.status(404).json({ message: "One or more attached images were not found. Please attach them again." })
    }
    const currentById = new Map(currentImages.map((image) => [image.imageId, image]))
    const orderedImages = uniqueImageIds.map((id) => currentById.get(id))
    const imageQuery = [text, ...orderedImages.map((image) => image.caption)].filter(Boolean).join("\n")
    let relatedImages
    try {
      relatedImages = await findRelatedImages({
        userId: String(userId),
        projectId: normalizedProjectId,
        query: imageQuery,
        excludeImageIds: uniqueImageIds,
      })
    } catch (error) {
      console.error("Image retrieval error:", error)
      return res.status(502).json({ message: "AmeekAi could not search your saved images. Please try again." })
    }

    const imageContext = [
      orderedImages.length && `Images attached to this message:\n${orderedImages.map((image) => `- "${image.name}": ${image.caption}`).join("\n")}`,
      relatedImages.length && `Related images retrieved from this project's image library:\n${relatedImages.map((image) => `- "${image.name}": ${image.caption}`).join("\n")}`,
    ].filter(Boolean).join("\n\n")
    const content = [withAttachments(text, attachments), imageContext].filter(Boolean).join("\n\n")

    const threadId = randomUUID()
    runs.set(threadId, { userId: String(userId), projectId: normalizedProjectId, context: cleanContext(context), updatedAt: Date.now() })

    return step(res, threadId, { messages: [...buildHistory(history), new HumanMessage(content)] })
  } catch (error) {
    console.error("AI chat error:", error)
    return res.status(500).json({ message: "AI chat error" })
  }
}

export const uploadImage = async (req, res) => {
  const userId = req.headers["x-user-id"]
  if (!userId) return res.status(401).json({ message: "Unauthorized" })

  const { projectId, name, mimeType, data } = req.body || {}
  if (typeof projectId !== "string" || !projectId.trim()) {
    return res.status(400).json({ message: "projectId is required" })
  }
  if (typeof name !== "string" || !name.trim() || name.length > 255) {
    return res.status(400).json({ message: "A valid image name is required" })
  }
  if (!IMAGE_TYPES.has(mimeType)) {
    return res.status(415).json({ message: "Use a JPEG, PNG, WebP, or GIF image" })
  }
  if (typeof data !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
    return res.status(400).json({ message: "Image data must be base64 encoded" })
  }

  const bytes = Buffer.from(data, "base64")
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== data) {
    return res.status(413).json({ message: "Each image must be no larger than 8 MB" })
  }

  try {
    const caption = await describeImage(mimeType, data)
    const embedding = await embedImageText(caption, "RETRIEVAL_DOCUMENT")
    const imageId = randomUUID()
    await Image.create({
      imageId,
      userId: String(userId),
      projectId: projectId.trim(),
      name: name.trim(),
      mimeType,
      data: bytes,
      caption,
      embedding,
    })
    return res.status(201).json({ imageId, caption })
  } catch (error) {
    console.error("Image indexing error:", error)
    if (isRateLimited(error)) {
      return res.status(429).json({ message: "AmeekAi is temporarily out of image-processing quota. Try again later." })
    }
    return res.status(502).json({ message: "AmeekAi could not process this image. Check the AI service and try again." })
  }
}

export const getImage = async (req, res) => {
  const userId = req.headers["x-user-id"]
  if (!userId) return res.status(401).json({ message: "Unauthorized" })

  try {
    const image = await Image.findOne({
      imageId: req.params.imageId,
      userId: String(userId),
    }).select("+data")
    if (!image) return res.status(404).json({ message: "Image not found" })

    return res
      .status(200)
      .type(image.mimeType)
      .set("Cache-Control", "private, max-age=3600")
      .send(image.data)
  } catch (error) {
    console.error("Image retrieval error:", error)
    return res.status(500).json({ message: "Could not retrieve this image" })
  }
}

export const resume = async (req, res) => {
  try {
    const { threadId, results } = req.body
    const userId = req.headers["x-user-id"]
    const run = runs.get(threadId)

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" })
    }
    // Unknown, expired, or someone else's run
    if (!run || run.userId !== String(userId)) {
      return res.status(404).json({ message: "This AmeekAi request expired. Please send your message again." })
    }
    if (!Array.isArray(results)) {
      return res.status(400).json({ message: "results must be an array" })
    }

    return step(res, threadId, new Command({ resume: results }))
  } catch (error) {
    console.error("AI resume error:", error)
    return res.status(500).json({ message: "AI resume error" })
  }
}

// The user pressed Stop: drop the paused run
export const cancel = async (req, res) => {
  const { threadId } = req.body
  const run = runs.get(threadId)
  if (run && run.userId === String(req.headers["x-user-id"])) await endRun(threadId)
  return res.json({ status: "cancelled" })
}
