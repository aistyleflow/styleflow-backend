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

// ✅ Reusable function — sends product details + image
function sendProductMessage(twiml, product) {

  // ✅ Show ALL fields to confirm image_url is present
  console.log("FULL PRODUCT OBJECT:", JSON.stringify(product, null, 2));
  console.log("Selected image:", product.image_url || "NONE — no image_url found");

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

  if (product.image_url) {
    console.log("About to send media:", product.image_url);
    message.media(product.image_url);
    console.log("✅ Media attached successfully");
  } else {
    console.log("⚠️ No image URL — skipping media");
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
    const isNumber = /^[0-9]+$/.test(msg);

    // ✅ NUMBER CHECK FIRST
    if (isNumber) {
      console.log(`🔢 Number received: ${msg}`);
      const index = parseInt(msg) - 1;

      const { data: session, error: sessionError } = await supabase
        .from("user_sessions")
        .select("*")
        .eq("phone_number", phone)
        .limit(1)
        .maybeSingle();

      console.log("🔍 Session lookup for:", phone);
      console.log("📋 Session:", JSON.stringify(session, null, 2));
      console.log("❗ Session error:", sessionError ? sessionError.message : "none");

      if (sessionError) {
        twiml.message(`⚠️ Something went wrong. Please search again!\n\nExample: type *Black* or *Jeans*`);
        res.writeHead(200, { "Content-Type": "text/xml" });
        return res.end(twiml.toString());
      }

      if (!session || !session.last_results) {
        twiml.message(`⚠️ Session expired. Please search again!\n\nExample: type *Black* or *Jeans*`);
        res.writeHead(200, { "Content-Type": "text/xml" });
        return res.end(twiml.toString());
      }

      const sessionProduct = session.last_results[index];

      if (!sessionProduct) {
        const max = session.last_results.length;
        twiml.message(`⚠️ Invalid selection.\n\nPlease choose a number between *1* and *${max}*`);
        res.writeHead(200, { "Content-Type": "text/xml" });
        return res.end(twiml.toString());
      }

      // ✅ KEY FIX — re-fetch product fresh from Supabase using product_name
      // This guarantees image_url and ALL fields are always present
      const { data: freshProduct, error: fetchError } = await supabase
        .from("products")
        .select("*")
        .eq("product_name", sessionProduct.product_name)
        .maybeSingle();

      console.log("🔄 Fresh product fetch:", JSON.stringify(freshProduct, null, 2));
      console.log("❗ Fetch error:", fetchError ? fetchError.message : "none");

      if (fetchError || !freshProduct) {
        console.error("❌ Could not fetch fresh product");
        twiml.message(`⚠️ Product not found. Please search again!`);
        res.writeHead(200, { "Content-Type": "text/xml" });
        return res.end(twiml.toString());
      }

      // ✅ Send using fresh product — image_url guaranteed
      sendProductMessage(twiml, freshProduct);

      res.writeHead(200, { "Content-Type": "text/xml" });
      return res.end(twiml.toString());
    }

    // ✅ SEARCH LOGIC SECOND
    console.log(`🔍 Searching products for: "${msg}"`);

    const { data, error } = await supabase
      .from("products")
      .select("*") // ✅ fetches ALL columns including image_url
      .or(`product_name.ilike.%${msg}%,category.ilike.%${msg}%,color.ilike.%${msg}%`);

    console.log("📊 Products found:", data ? data.length : 0);
    console.log("❗ Search error:", error ? error.message : "none");

    if (data && data.length > 0) {

      // ✅ Save full product data including image_url to session
      const { error: upsertError } = await supabase
        .from("user_sessions")
        .upsert({
          phone_number: phone,
          last_results: data  // ✅ full product objects saved
        });

      if (upsertError) {
        console.error("❌ Session save error:", upsertError.message);
      } else {
        console.log(`✅ Session saved — PHONE: ${phone} — RESULTS: ${data.length}`);
        // ✅ Log first product to confirm image_url is saved
        console.log("✅ First product saved:", JSON.stringify(data[0], null, 2));
      }

      // ✅ Single result — send directly with image
      if (data.length === 1) {
        console.log("✅ Single product — sending directly");
        sendProductMessage(twiml, data[0]);

      } else {
        // ✅ Multiple results — numbered list
        let response = `🛍️ *StyleFlow* — Products matching "${msg}":\n\n`;

        data.forEach((product, index) => {
          response += `${index + 1}. *${product.product_name}*\n`;
          response += `   💰 ₹${product.price}\n`;
          response += `   📦 Stock: ${product.stock}\n`;
          response += `   📐 Size: ${product.size}\n`;
          response += `   🎨 Color: ${product.color}\n`;
          response += product.image_url ? `   🖼️ Image available\n\n` : `\n`;
        });

        response += `_Reply with a number (1, 2, 3...) to see full details + image!_`;
        twiml.message(response);
      }

    } else {
      twiml.message(
        `Sorry, we couldn't find any product matching "${msg}". 😔\n\n` +
        `Try a different keyword!\n` +
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

// 4. Products route
app.get("/products", async (req, res) => {
  try {
    const { data, error } = await supabase.from("products").select("*");

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    if (!data || data.length === 0) {
      return res.status(200).json({ message: "No products found" });
    }

    res.status(200).json(data);

  } catch (error) {
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