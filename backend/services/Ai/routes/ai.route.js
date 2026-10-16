import express from "express"
import { cancel, chat, getImage, resume, uploadImage } from "../controller/ai.controller.js"

const router = express.Router()

router.post("/chat", chat)
router.post("/chat/resume", resume)
router.post("/chat/cancel", cancel)
router.post("/images", uploadImage)
router.get("/images/:imageId", getImage)

export default router
