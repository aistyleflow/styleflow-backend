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

// ✅ Reusable function — sends product details + image in both paths
function sendProductMessage(twiml, product) {
  const message = twiml.message();

  message.body(
    `🛍️ *Product Details*\n\n` +
    `📦 Product: ${product.product_name}\n` +
    `💰 Price: ₹${product.price}\n` +
    `📦 Stock: ${product.stock}\n` +
    `📐 Size: ${product.size}\n` +
    `🎨 Color: ${product.color}\n\n` +
    `_Search another keyword to find more products!_`
  );

  // ✅ Attach image if URL exists
  if (product.image_url) {
    console.log(`🖼️ Attaching image: ${product.image_url}`);
    message.media(product.image_url);
  } else {
    console.log("ℹ️ No image URL for this product");
  }
}

// 3. WhatsApp incoming messages (POST)
app.post("/whatsapp", async (req, res) => {
  try {
    const body = req.body;

    if (!body) {
      console.log("⚠️ Empty request received");
      return res.status(400).end();
    }

    // ✅ Raw phone — zero modification
    const phone = body.From;
    const msg = body.Body ? body.Body.trim() : "";

    console.log("=================================");
    console.log("📩 New message received");
    console.log("PHONE RAW VALUE:", phone);
    console.log("MESSAGE:", msg);
    console.log("=================================");

    if (!phone || !msg) {
      console.log("⚠️ Missing phone or message");
      return res.status(400).end();
    }

    const twiml = new twilio.twiml.MessagingResponse();

    // ✅ NUMBER CHECK FIRST
    const isNumber = /^[0-9]+$/.test(msg);

    if (isNumber) {
      console.log(`🔢 Number received: ${msg}`);
      const index = parseInt(msg) - 1;

      // Fetch session from Supabase
      const { data: session, error: sessionError } = await supabase
        .from("user_sessions")
        .select("*")
        .eq("phone_number", phone)
        .limit(1)
        .maybeSingle();

      console.log("🔍 Looking up session for:", phone);
      console.log("📋 Session found:", JSON.stringify(session, null, 2));
      console.log("❗ Session error:", sessionError ? sessionError.message : "none");

      // Guard: Supabase error
      if (sessionError) {
        console.error("❌ Supabase session error:", sessionError.message);
        twiml.message(
          `⚠️ Something went wrong. Please search again!\n\nExample: type *Black* or *Jeans*`
        );
        res.writeHead(200, { "Content-Type": "text/xml" });
        return res.end(twiml.toString());
      }

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
        const max = session.last_results.length;
        console.log(`⚠️ Invalid index ${index} — only ${max} results`);
        twiml.message(
          `⚠️ Invalid selection.\n\nPlease choose a number between *1* and *${max}*`
        );
        res.writeHead(200, { "Content-Type": "text/xml" });
        return res.end(twiml.toString());
      }

      // ✅ Debug — verify product and image URL
      console.log("SELECTED PRODUCT:", JSON.stringify(product, null, 2));
      console.log("IMAGE URL:", product.image_url || "none");

      // ✅ Path 2 — Send product details + image using shared function
      sendProductMessage(twiml, product);

      res.writeHead(200, { "Content-Type": "text/xml" });
      return res.end(twiml.toString());
    }

    // ✅ SEARCH LOGIC SECOND
    console.log(`🔍 Searching products for: "${msg}"`);

    const { data, error } = await supabase
      .from("products")
      .select("*")
      .or(
        `product_name.ilike.%${msg}%,category.ilike.%${msg}%,color.ilike.%${msg}%`
      );

    console.log("📊 Products found:", data ? data.length : 0);
    console.log("❗ Search error:", error ? error.message : "none");

    if (data && data.length > 0) {

      // ✅ Save session with raw phone
      const { error: upsertError } = await supabase
        .from("user_sessions")
        .upsert({
          phone_number: phone,
          last_results: data
        });

      if (upsertError) {
        console.error("❌ Session save error:", upsertError.message);
      } else {
        console.log(`✅ Session saved — PHONE: ${phone} — RESULTS: ${data.length}`);
      }

      // ✅ Verify session saved
      const { data: verify } = await supabase
        .from("user_sessions")
        .select("phone_number")
        .eq("phone_number", phone)
        .maybeSingle();

      console.log("🔎 Session verification:", verify ? "SAVED ✅" : "NOT SAVED ❌");

      // ✅ If only 1 result — send details + image directly (Path 1)
      if (data.length === 1) {
        console.log("✅ Single product found — sending details directly");
        console.log("SELECTED PRODUCT:", JSON.stringify(data[0], null, 2));
        console.log("IMAGE URL:", data[0].image_url || "none");
        sendProductMessage(twiml, data[0]);

      } else {
        // ✅ Multiple results — show numbered list
        let response = `🛍️ *StyleFlow* — Products matching "${msg}":\n\n`;

        data.forEach((product, index) => {
          response += `${index + 1}. *${product.product_name}*\n`;
          response += `   💰 ₹${product.price}\n`;
          response += `   📦 Stock: ${product.stock}\n`;
          response += `   📐 Size: ${product.size}\n`;
          response += `   🎨 Color: ${product.color}\n`;
          response += product.image_url
            ? `   🖼️ Image available\n\n`
            : `\n`;
        });

        response += `_Reply with a number (1, 2, 3...) to see full details + image!_`;
        twiml.message(response);
      }

    } else {
      console.log("⚠️ No product found for:", msg);
      twiml.message(
        `Sorry, we couldn't find any product matching "${msg}". 😔\n\n` +
        `Try searching with a different keyword!\n` +
        `Example: *Black*, *Jeans*, *XL*`
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

    if (error) {
      console.error("❌ Supabase error:", error.message);
      return res.status(500).json({
        error: error.message,
        hint: "Check your Supabase table name and environment variables"
      });
    }

    if (!data || data.length === 0) {
      return res.status(200).json({
        message: "No products found",
        hint: "Check if table is named exactly 'products' and has data"
      });
    }

    console.log(`✅ ${data.length} products fetched`);
    res.status(200).json(data);

  } catch (error) {
    console.error("❌ Error fetching products:", error.message);
    res.status(500).json({ error: "Something went wrong" });
  }
});

// 5. 404 handler - ALWAYS LAST
app.use((req, res) => {
  console.log(`⚠️ Unknown route: ${req.method} ${req.url}`);
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