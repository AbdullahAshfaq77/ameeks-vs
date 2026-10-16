// Loaded before the other imports so utils/llm.js sees GOOGLE_API_KEY when it is created
import "dotenv/config"
import express from "express"
import { connectDb } from "./config/db.js"
import router from "./routes/ai.route.js"

const port = process.env.PORT || 8004

const app = express()
// Tool results carry whole files back from the browser
app.use(express.json({ limit: "12mb" }))
app.use("/", router)
app.get("/",(req,res)=>{
   res.json({"message":"Hello from Ai service!"})
})

app.listen(port,()=>{
    connectDb()
     console.log(`Ai service satrted at ${port}`)
})
