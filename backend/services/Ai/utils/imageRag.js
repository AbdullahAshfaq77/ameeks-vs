import { Image } from "../models/image.model.js"

const EMBEDDING_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent"
const EMBEDDING_DIMENSIONS = 768
const MAX_RETRIEVED_IMAGES = 4

export const embedImageText = async (text, taskType) => {
  const apiKey = process.env.GOOGLE_API_KEY
  if (!apiKey) throw new Error("GOOGLE_API_KEY is required for image retrieval")

  const response = await fetch(EMBEDDING_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      model: "models/gemini-embedding-001",
      content: { parts: [{ text }] },
      taskType,
      outputDimensionality: EMBEDDING_DIMENSIONS,
    }),
  })
  if (!response.ok) {
    throw new Error(`Gemini image embedding failed with status ${response.status}: ${(await response.text()).slice(0, 500)}`)
  }

  const result = await response.json()
  const values = result.embedding?.values
  if (!Array.isArray(values) || values.length !== EMBEDDING_DIMENSIONS || values.some((value) => !Number.isFinite(value))) {
    throw new Error("Gemini returned an invalid image embedding")
  }
  return values
}

export const findRelatedImages = async ({ userId, projectId, query, excludeImageIds = [] }) => {
  const text = query.trim()
  if (!text) return []

  const filter = { userId, projectId, imageId: { $nin: excludeImageIds } }
  if (!await Image.exists(filter)) return []

  const queryEmbedding = await embedImageText(text, "RETRIEVAL_QUERY")
  const magnitude = Math.sqrt(queryEmbedding.reduce((sum, value) => sum + value * value, 0))
  if (!magnitude) return []

  const cursor = Image.find(filter)
    .select("imageId name caption createdAt +embedding -data")
    .sort({ createdAt: -1 })
    .lean()
    .cursor({ batchSize: 100 })

  const best = []
  for await (const image of cursor) {
    const vector = image.embedding || []
    if (vector.length !== queryEmbedding.length) continue
    const dot = vector.reduce((sum, value, index) => sum + value * queryEmbedding[index], 0)
    const vectorMagnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
    const similarity = vectorMagnitude ? dot / (magnitude * vectorMagnitude) : 0
    if (similarity < 0.25) continue

    best.push({ ...image, similarity })
    best.sort((left, right) => right.similarity - left.similarity)
    if (best.length > MAX_RETRIEVED_IMAGES) best.pop()
  }
  return best
}
