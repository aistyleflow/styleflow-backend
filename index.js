const express = require("express");
const twilio = require("twilio");
const { createClient } = require("@supabase/supabase-js");

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Twilio client
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ✅ ROUTE ORDER MATTERS - specific routes first, 404 last

// 1. Home route
app.get("/", (req, res) => {
  res.send("StyleFlow is running!");
});

// 2. WhatsApp webhook verification (GET)
app.get("/whatsapp", (req, res) => {
  console.log("Someone accessed WhatsApp endpoint");

  const VERIFY_TOKEN = "styleflow_token";
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified by Meta!");
    res.status(200).send(challenge);
  } else {
    res.status(200).send("WhatsApp webhook is active!");
  }
});

// 3. WhatsApp incoming messages (POST)
app.post("/whatsapp", async (req, res) => {
  try {
    const body = req.body;

    if (!body) {
      console.log("⚠️ Empty request received");
      return res.status(400).end();
    }

    const sender = body.From;
    const message = body.Body;

    console.log("📩 WhatsApp message received");
    console.log(`👤 From: ${sender}`);
    console.log(`💬 Message: ${message}`);
    console.log(JSON.stringify(body, null, 2));

    if (!sender) {
      console.log("⚠️ No sender found in request");
      return res.status(400).end();
    }

    await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: sender,
      body: "Welcome to StyleFlow! 🛍️"
    });

    console.log(`✅ Reply sent to ${sender}`);
    res.status(200).end();

  } catch (error) {
    console.error("❌ Error handling message:", error.message);
    res.status(500).end();
  }
});

// 4. Products route - fetch from Supabase
app.get("/products", async (req, res) => {
  try {
    console.log("📦 Fetching products from Supabase...");

    const { data, error } = await supabase
      .from("products")
      .select("*");

    if (error) {
      console.error("❌ Supabase error:", error.message);
      return res.status(500).json({ error: error.message });
    }

    if (!data || data.length === 0) {
      console.log("⚠️ No products found");
      return res.status(404).json({ message: "No products found" });
    }

    console.log(`✅ ${data.length} products fetched`);
    res.status(200).json(data);

  } catch (error) {
    console.error("❌ Error fetching products:", error.message);
    res.status(500).json({ error: "Something went wrong" });
  }
});

// 5. 404 handler - ALWAYS LAST ✅
app.use((req, res) => {
  console.log(`⚠️ Unknown route accessed: ${req.method} ${req.url}`);
  res.status(404).send("Route not found");
});

// 6. Error handling - ALWAYS LAST ✅
app.use((err, req, res, next) => {
  console.error("❌ Error:", err.stack);
  res.status(500).send("Something went wrong!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 StyleFlow server running on port ${PORT}`);
});