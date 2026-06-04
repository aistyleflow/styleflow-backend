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
    const incomingMsg = body.Body ? body.Body.trim() : "";

    console.log("📩 WhatsApp message received");
    console.log(`👤 From: ${sender}`);
    console.log(`💬 Message: ${incomingMsg}`);

    if (!sender) {
      console.log("⚠️ No sender found in request");
      return res.status(400).end();
    }

    // Search products in Supabase
    const { data, error } = await supabase
      .from("products")
      .select("*")
      .ilike("product_name", `%${incomingMsg}%`);

    console.log("📊 Search results:", JSON.stringify(data, null, 2));
    console.log("❗ Search error:", error);

    const twiml = new twilio.twiml.MessagingResponse();

    // ✅ Step 2 — Show all matching products
    if (data && data.length > 0) {
      console.log(`✅ ${data.length} product(s) found for: ${incomingMsg}`);

      let response = `🛍️ *StyleFlow* — Products matching "${incomingMsg}":\n\n`;

      data.forEach((product, index) => {
        response += `${index + 1}. *${product.product_name}*\n`;
        response += `   💰 ₹${product.price}\n`;
        response += `   📦 Stock: ${product.stock}\n`;
        response += `   📐 Size: ${product.size}\n`;
        response += `   🎨 Color: ${product.color}\n\n`;
      });

      response += `_Reply with a product name to know more!_`;

      twiml.message(response);

    } else {
      console.log("⚠️ No product found for:", incomingMsg);
      twiml.message(
        `Sorry, we couldn't find any product matching "${incomingMsg}". 😔\n\nTry searching with a different keyword!`
      );
    }

    res.writeHead(200, { "Content-Type": "text/xml" });
    res.end(twiml.toString());

  } catch (error) {
    console.error("❌ Error handling message:", error.message);
    res.status(500).end();
  }
});

// 4. Products route - fetch all from Supabase
app.get("/products", async (req, res) => {
  try {
    console.log("📦 Fetching products from Supabase...");

    const { data, error } = await supabase
      .from("products")
      .select("*");

    console.log("📊 DATA:", JSON.stringify(data, null, 2));
    console.log("❗ ERROR:", error);

    if (error) {
      console.error("❌ Supabase error:", error.message);
      return res.status(500).json({
        error: error.message,
        hint: "Check your Supabase table name and environment variables"
      });
    }

    if (!data || data.length === 0) {
      console.log("⚠️ No products found in table");
      return res.status(200).json({
        message: "No products found",
        hint: "Check if your Supabase table is named exactly 'products' and has data in it"
      });
    }

    console.log(`✅ ${data.length} products fetched successfully`);
    res.status(200).json(data);

  } catch (error) {
    console.error("❌ Error fetching products:", error.message);
    res.status(500).json({ error: "Something went wrong" });
  }
});

// 5. 404 handler - ALWAYS LAST
app.use((req, res) => {
  console.log(`⚠️ Unknown route accessed: ${req.method} ${req.url}`);
  res.status(404).send("Route not found");
});

// 6. Error handling - ALWAYS LAST
app.use((err, req, res, next) => {
  console.error("❌ Error:", err.stack);
  res.status(500).send("Something went wrong!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 StyleFlow server running on port ${PORT}`);
});