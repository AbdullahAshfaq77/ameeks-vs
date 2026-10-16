import mongoose from "mongoose"

const imageSchema = new mongoose.Schema({
  imageId: { type: String, required: true, unique: true },
  userId: { type: String, required: true, index: true },
  projectId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  mimeType: { type: String, required: true },
  data: { type: Buffer, required: true, select: false },
  caption: { type: String, required: true },
  embedding: { type: [Number], required: true, select: false },
  createdAt: { type: Date, default: Date.now, required: true },
})

imageSchema.index({ userId: 1, projectId: 1, createdAt: -1 })

export const Image = mongoose.models.Image || mongoose.model("Image", imageSchema)
