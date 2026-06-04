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

    // ✅ Step 1 — Fix phone format (strip whatsapp: prefix)
    const phone = body.From
      ? body.From.replace("whatsapp:", "").trim()
      : null;

    const msg = body.Body ? body.Body.trim() : "";

    console.log("📩 WhatsApp message received");
    console.log(`👤 From: ${phone}`);
    console.log(`💬 Message: ${msg}`);

    if (!phone) {
      console.log("⚠️ No sender found in request");
      return res.status(400).end();
    }

    const twiml = new twilio.twiml.MessagingResponse();

    // ✅ Step 4 — Use regex for reliable number detection
    const isNumber = /^[0-9]+$/.test(msg);

    // ✅ Step 5 — NUMBER CHECK FIRST (VERY IMPORTANT)
    if (isNumber) {
      console.log(`🔢 User sent number: ${msg}`);
      const index = parseInt(msg) - 1;

      // Fetch saved session from Supabase
      const { data: session, error: sessionError } = await supabase
        .from("user_sessions")
        .select("*")
        .eq("phone_number", phone)
        .single();

      console.log("📋 Session data:", JSON.stringify(session, null, 2));
      console.log("❗ Session error:", sessionError);

      // Guard: no session found
      if (!session || !session.last_results) {
        console.log("⚠️ No session found for:", phone);
        twiml.message(
          `⚠️ Session expired. Please search again!\n\nExample: type *Black* or *Jeans*`
        );
        res.writeHead(200, { "Content-Type": "text/xml" });
        return res.end(twiml.toString());
      }

      const product = session.last_results[index];

      // Guard: invalid index
      if (!product) {
        console.log(`⚠️ Invalid index ${index} for session results`);
        twiml.message(
          `⚠️ Invalid selection. Please choose a correct number.\n\nExample: if list shows 3 products, reply *1*, *2* or *3*`
        );
        res.writeHead(200, { "Content-Type": "text/xml" });
        return res.end(twiml.toString());
      }

      console.log(`✅ Product selected: ${product.product_name}`);

      twiml.message(
        `🛍️ *Product Details*\n\n` +
        `📦 Product: ${product.product_name}\n` +
        `💰 Price: ₹${product.price}\n` +
        `📦 Stock: ${product.stock}\n` +
        `📐 Size: ${product.size}\n` +
        `🎨 Color: ${product.color}\n\n` +
        `_Search another keyword to find more products!_`
      );

      res.writeHead(200, { "Content-Type": "text/xml" });
      return res.end(twiml.toString());
    }

    // ✅ Step 5 — SEARCH LOGIC SECOND
    console.log(`🔍 Searching products for: ${msg}`);

    const { data, error } = await supabase
      .from("products")
      .select("*")
      .or(
        `product_name.ilike.%${msg}%,category.ilike.%${msg}%,color.ilike.%${msg}%`
      );

    console.log("📊 Search results:", JSON.stringify(data, null, 2));
    console.log("❗ Search error:", error);

    if (data && data.length > 0) {

      // ✅ Step 2 — Save session correctly with onConflict
      const { error: upsertError } = await supabase
        .from("user_sessions")
        .upsert({
          phone_number: phone,
          last_results: data
        }, { onConflict: "phone_number" });

      if (upsertError) {
        console.error("❌ Session save error:", upsertError.message);
      } else {
        console.log(`✅ Session saved for ${phone} with ${data.length} results`);
      }

      let response = `🛍️ *StyleFlow* — Products matching "${msg}":\n\n`;

      data.forEach((product, index) => {
        response += `${index + 1}. *${product.product_name}*\n`;
        response += `   💰 ₹${product.price}\n`;
        response += `   📦 Stock: ${product.stock}\n`;
        response += `   📐 Size: ${product.size}\n`;
        response += `   🎨 Color: ${product.color}\n\n`;
      });

      response += `_Reply with a number (1, 2, 3...) to see full details!_`;

      twiml.message(response);

    } else {
      console.log("⚠️ No product found for:", msg);
      twiml.message(
        `Sorry, we couldn't find any product matching "${msg}". 😔\n\nTry searching with a different keyword!\nExample: *Black*, *Jeans*, *XL*`
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