import { api } from "../utils/axios"

const errorMessage = (error) => error.response?.data?.message || "AmeekAi could not be reached. Check the AI service and try again."
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_IMAGE_DIMENSION = 2048
const MAX_SOURCE_IMAGE_BYTES = 64 * 1024 * 1024
const UPLOAD_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"])

// One chat turn. The AI service pauses at every tool call; the calls are run here in the
// browser (runTool) and their results sent back, until the model answers with text.
// onToolCall(call) and onToolResult(call, result) report progress for the chat panel.
export const runAmeekAi = async ({ projectId, message, history, attachments, context, runTool, onToolCall, onToolResult, signal }) => {
       let threadId = null
       try {
        const textAttachments = attachments.filter((file) => file.kind !== "image")
        const imageIds = attachments.filter((file) => file.kind === "image").map((file) => file.imageId)
        let { data } = await api.post("/api/ai/chat", { projectId, message, history, attachments: textAttachments, imageIds, context }, { signal })
        threadId = data.threadId

        while (data.status === "tool_calls") {
               const results = []
               // In order: a batch can create a folder and then files inside it
               for (const call of data.toolCalls) {
                      if (signal?.aborted) throw new DOMException("Stopped", "AbortError")
                      onToolCall?.(call)
                      const result = await runTool(call)
                      onToolResult?.(call, result)
                      results.push({ id: result.id, output: result.output })
               }
               ;({ data } = await api.post("/api/ai/chat/resume", { threadId, results }, { signal }))
        }
        return { reply: data.reply ?? "" }
       } catch (error) {
        if (signal?.aborted || error?.name === "AbortError" || error?.name === "CanceledError") {
               // Frees the paused run on the server; it would expire on its own anyway
               if (threadId) api.post("/api/ai/chat/cancel", { threadId }).catch(() => {})
               return { stopped: true }
        }
        console.log(error)
        return { error: errorMessage(error) }
       }
}

const toBase64 = async (file) => {
       const bytes = new Uint8Array(await file.arrayBuffer())
       const chunks = []
       const chunkSize = 0x8000
       for (let offset = 0; offset < bytes.length; offset += chunkSize) {
              chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)))
       }
       return btoa(chunks.join(""))
}

const canvasBlob = (canvas, type, quality) => new Promise((resolve, reject) => {
       canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("This image could not be resized in your browser.")), type, quality)
})

export const prepareAmeekAiImage = async (file) => {
       if (!file.type.startsWith("image/")) {
              throw new Error("Clipboard data did not contain a supported image.")
       }
       if (file.size > MAX_SOURCE_IMAGE_BYTES) {
              throw new Error("This image is over 64 MB. Choose a smaller source image and try again.")
       }
       if (typeof createImageBitmap !== "function") {
              throw new Error("Image resizing is not supported by this browser.")
       }

       let bitmap
       try {
              bitmap = await createImageBitmap(file)
       } catch {
              throw new Error("This image could not be opened. Try a JPEG, PNG, WebP, or GIF image.")
       }

       try {
              const longestSide = Math.max(bitmap.width, bitmap.height)
              if (longestSide <= MAX_IMAGE_DIMENSION && file.size <= MAX_IMAGE_BYTES && UPLOAD_IMAGE_TYPES.has(file.type)) return file

              let scale = Math.min(1, MAX_IMAGE_DIMENSION / longestSide)
              let quality = 0.86
              const canvas = document.createElement("canvas")
              const context = canvas.getContext("2d")
              if (!context) throw new Error("Image resizing is not supported by this browser.")

              for (let attempt = 0; attempt < 10; attempt++) {
                     canvas.width = Math.max(1, Math.round(bitmap.width * scale))
                     canvas.height = Math.max(1, Math.round(bitmap.height * scale))
                     context.clearRect(0, 0, canvas.width, canvas.height)
                     context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)

                     let blob = await canvasBlob(canvas, "image/webp", quality)
                     if (blob.type !== "image/webp") {
                            context.fillStyle = "#fff"
                            context.fillRect(0, 0, canvas.width, canvas.height)
                            context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
                            blob = await canvasBlob(canvas, "image/jpeg", quality)
                     }
                     if (blob.size <= MAX_IMAGE_BYTES) {
                            const extension = blob.type === "image/webp" ? ".webp" : ".jpg"
                            const name = file.name.replace(/\.[^.]+$/, "") + extension
                            return new File([blob], name, { type: blob.type, lastModified: file.lastModified })
                     }

                     if (quality > 0.62) quality -= 0.08
                     else {
                            quality = 0.62
                            scale *= 0.8
                     }
              }
              throw new Error("This image could not be reduced below 8 MB. Choose a smaller image and try again.")
       } finally {
              bitmap.close()
       }
}

export const uploadAmeekAiImage = async ({ projectId, file, name = file.name, signal }) => {
       const { data } = await api.post("/api/ai/images", {
              projectId,
              name,
              mimeType: file.type,
              data: await toBase64(file),
       }, { signal })
       if (typeof data.imageId !== "string" || !data.imageId) {
              throw new Error("AmeekAi could not save this image. Please try again.")
       }
       return { imageId: data.imageId }
}

export const getAmeekAiImage = async (imageId) => {
       const { data } = await api.get(`/api/ai/images/${encodeURIComponent(imageId)}`, { responseType: "blob" })
       return data
}
