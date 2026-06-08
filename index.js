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

// ✅ Greeting keywords
const GREETINGS = ["hi", "hello", "hey", "helo", "hii", "start", "namaste"];

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

// ✅ Check if image URL is publicly accessible
async function isImageAccessible(url) {
  try {
    const response = await fetch(url, { method: "HEAD" });
    console.log(`🔎 Image URL check: ${url} → status ${response.status}`);
    return response.ok;
  } catch (err) {
    console.error("❌ Image URL not accessible:", err.message);
    return false;
  }
}

// ✅ Send message via Twilio REST API directly
async function sendWhatsAppMessage(to, messageBody) {
  try {
    const message = await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: to,
      body: messageBody
    });
    console.log("✅ Message sent via REST API — SID:", message.sid);
    return true;
  } catch (err) {
    console.error("❌ REST API send error:", err.message);
    return false;
  }
}

// ✅ Reusable function — sends product details + image
async function sendProductMessage(twiml, product) {
  console.log("FULL PRODUCT OBJECT:", JSON.stringify(product, null, 2));
  console.log("Selected image:", product.image_url || "NONE");

  const message = twiml.message();

  message.body(
    `🛍️ *Product Details*\n\n` +
    `📦 Product: ${product.product_name}\n` +
    `💰 Price: ₹${product.price}\n` +
    `📦 Stock: ${product.stock}\n` +
    `📐 Size: ${product.size}\n` +
    `🎨 Color: ${product.color}\n\n` +
    `💬 Reply *ADD* to add to cart\n` +
    `🛒 Reply *CART* to view your cart`
  );

  if (product.image_url) {
    const accessible = await isImageAccessible(product.image_url);
    if (accessible) {
      console.log("About to send media:", product.image_url);
      message.media(product.image_url);
      console.log("✅ Media attached successfully");
    } else {
      console.log("❌ Image not publicly accessible");
    }
  } else {
    console.log("⚠️ No image URL — skipping media");
  }
}

// ✅ Safe session save
async function saveSession(phone, data) {
  try {
    const { data: existing } = await supabase
      .from("user_sessions")
      .select("phone_number")
      .eq("phone_number", phone)
      .maybeSingle();

    let saveError;

    if (existing) {
      const { error } = await supabase
        .from("user_sessions")
        .update({ last_results: data })
        .eq("phone_number", phone);
      saveError = error;
      console.log("🔄 Session updated for:", phone);
    } else {
      const { error } = await supabase
        .from("user_sessions")
        .insert({ phone_number: phone, last_results: data });
      saveError = error;
      console.log("🆕 Session created for:", phone);
    }

    if (saveError) {
      console.error("❌ Session save error:", saveError.message);
      return false;
    }

    const { data: verify } = await supabase
      .from("user_sessions")
      .select("last_results")
      .eq("phone_number", phone)
      .maybeSingle();

    if (verify && verify.last_results) {
      console.log(`✅ Session verified — ${verify.last_results.length} products saved`);
      verify.last_results.forEach((p, i) => {
        console.log(`   ${i + 1}. ${p.product_name}`);
      });
      return true;
    } else {
      console.error("❌ Session verification failed");
      return false;
    }

  } catch (err) {
    console.error("❌ Session save exception:", err.message);
    return false;
  }
}

// ✅ Save selected product ID to session
async function saveSelectedProduct(phone, productId) {
  try {
    const { error } = await supabase
      .from("user_sessions")
      .update({ selected_product_id: productId })
      .eq("phone_number", phone);

    if (error) {
      console.error("❌ Failed to save selected_product_id:", error.message);
      return false;
    }

    console.log(`✅ selected_product_id saved — product id: ${productId} for ${phone}`);
    return true;

  } catch (err) {
    console.error("❌ saveSelectedProduct exception:", err.message);
    return false;
  }
}

// ✅ TwiML response helper
function sendTwiml(res, twiml) {
  const xml = twiml.toString();
  console.log("📤 Final TwiML:", xml);
  res.setHeader("Content-Type", "text/xml");
  res.status(200).send(xml);
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
    const msgLower = msg.toLowerCase();
    const msgUpper = msg.toUpperCase();

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

    // ✅ 1. GREETING FIRST — via REST API
    if (GREETINGS.includes(msgLower)) {
      console.log("👋 Greeting received — sending via REST API");

      res.status(200).end();

      await sendWhatsAppMessage(
        phone,
        `👋 Welcome to *StyleFlow*! 🛍️\n\n` +
        `We are your personal fashion assistant.\n\n` +
        `🔍 *How to shop:*\n` +
        `Just type what you are looking for!\n\n` +
        `Examples:\n` +
        `• Type *Black* to see black products\n` +
        `• Type *Jeans* to see all jeans\n` +
        `• Type *XL* to see XL size items\n\n` +
        `Happy Shopping! 🎉`
      );

      return;
    }

    // ✅ 2. ADD COMMAND SECOND
    if (msgUpper === "ADD") {
      console.log("🛒 ADD command received for:", phone);

      const { data: session, error: sessionError } = await supabase
        .from("user_sessions")
        .select("selected_product_id")
        .eq("phone_number", phone)
        .maybeSingle();

      console.log("📋 Session for ADD:", JSON.stringify(session, null, 2));
      console.log("❗ Session error:", sessionError ? sessionError.message : "none");

      if (!session?.selected_product_id) {
        console.log("⚠️ No selected_product_id found for:", phone);
        twiml.message(
          `⚠️ Please select a product first.\n\n` +
          `Search for a product and select a number, then type *ADD*`
        );
        return sendTwiml(res, twiml);
      }

      // ✅ Fetch product details for confirmation
      const { data: product, error: productError } = await supabase
        .from("products")
        .select("*")
        .eq("id", session.selected_product_id)
        .maybeSingle();

      console.log("📦 Product to add:", product?.product_name);

      if (productError || !product) {
        twiml.message(`⚠️ Product not found. Please search and select again!`);
        return sendTwiml(res, twiml);
      }

      // ✅ Check if product already in cart
      const { data: existingCart } = await supabase
        .from("cart")
        .select("*")
        .eq("phone_number", phone)
        .eq("product_id", session.selected_product_id)
        .maybeSingle();

      if (existingCart) {
        // ✅ Already in cart — increase quantity instead
        const { error: updateError } = await supabase
          .from("cart")
          .update({ quantity: existingCart.quantity + 1 })
          .eq("id", existingCart.id);

        if (updateError) {
          console.error("❌ Cart update error:", updateError.message);
          twiml.message(`⚠️ Could not update cart. Please try again!`);
          return sendTwiml(res, twiml);
        }

        console.log(`✅ Cart quantity updated — ${product.product_name} x${existingCart.quantity + 1}`);

        twiml.message(
          `✅ *Cart Updated!*\n\n` +
          `📦 ${product.product_name}\n` +
          `💰 ₹${product.price}\n` +
          `🔢 Quantity: ${existingCart.quantity + 1}\n\n` +
          `🛒 Type *CART* to view your cart\n` +
          `🔍 Or search for more products!`
        );

      } else {
        // ✅ Not in cart — insert fresh
        const { error: cartError } = await supabase
          .from("cart")
          .insert({
            phone_number: phone,
            product_id: session.selected_product_id,
            quantity: 1
          });

        if (cartError) {
          console.error("❌ Cart insert error:", cartError.message);
          twiml.message(`⚠️ Could not add to cart. Please try again!`);
          return sendTwiml(res, twiml);
        }

        console.log(`✅ Product added to cart — ${product.product_name} for ${phone}`);

        twiml.message(
          `✅ *Added to Cart!*\n\n` +
          `📦 ${product.product_name}\n` +
          `💰 ₹${product.price}\n\n` +
          `🛒 Type *CART* to view your cart\n` +
          `🔍 Or search for more products!`
        );
      }

      return sendTwiml(res, twiml);
    }

    // ✅ 3. CART COMMAND THIRD
    if (msgUpper === "CART") {
      console.log("🛒 CART command received for:", phone);

      const { data: cartItems, error: cartError } = await supabase
        .from("cart")
        .select("*")
        .eq("phone_number", phone);

      console.log("🛒 Cart items:", JSON.stringify(cartItems, null, 2));
      console.log("❗ Cart error:", cartError ? cartError.message : "none");

      // Guard: empty cart
      if (!cartItems || cartItems.length === 0) {
        console.log("⚠️ Cart is empty for:", phone);
        twiml.message(
          `🛒 Your cart is empty.\n\n` +
          `Search for products to get started!\n` +
          `Example: Type *Black* or *Jeans*`
        );
        return sendTwiml(res, twiml);
      }

      let reply = `🛒 *Your Cart*\n\n`;
      let total = 0;
      let itemCount = 0;

      // ✅ Fetch each product details
      for (let i = 0; i < cartItems.length; i++) {
        const item = cartItems[i];

        const { data: product, error: productError } = await supabase
          .from("products")
          .select("*")
          .eq("id", item.product_id)
          .maybeSingle();  // ✅ maybeSingle instead of single — no crash

        if (productError) {
          console.error(`❌ Error fetching product ${item.product_id}:`, productError.message);
          continue; // ✅ skip broken item, don't crash
        }

        if (product) {
          const itemTotal = product.price * item.quantity;
          total += itemTotal;
          itemCount++;

          reply += `${i + 1}. *${product.product_name}*\n`;
          reply += `   💰 ₹${product.price} × ${item.quantity} = ₹${itemTotal}\n`;
          reply += `   📐 Size: ${product.size} | 🎨 Color: ${product.color}\n\n`;

          console.log(`   ${i + 1}. ${product.product_name} x${item.quantity} = ₹${itemTotal}`);
        }
      }

      reply += `─────────────────\n`;
      reply += `🧾 *Total: ₹${total}*\n`;
      reply += `📦 ${itemCount} item${itemCount > 1 ? "s" : ""} in cart\n\n`;
      reply += `Type *ORDER* to place your order\n`;
      reply += `🔍 Or search for more products!`;

      console.log(`✅ Cart shown — ${itemCount} items — Total: ₹${total}`);

      twiml.message(reply);
      return sendTwiml(res, twiml);
    }

    // ✅ 4. NUMBER CHECK FOURTH
    const isNumber = /^[0-9]+$/.test(msg);

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
      console.log("❗ Session error:", sessionError ? sessionError.message : "none");

      if (sessionError) {
        twiml.message(`⚠️ Something went wrong. Please search again!\n\nExample: type *Black* or *Jeans*`);
        return sendTwiml(res, twiml);
      }

      if (!session || !session.last_results) {
        twiml.message(`⚠️ Session expired. Please search again!\n\nExample: type *Black* or *Jeans*`);
        return sendTwiml(res, twiml);
      }

      console.log("📦 Products in session (in order):");
      session.last_results.forEach((p, i) => {
        console.log(`   ${i + 1}. ${p.product_name}`);
      });
      console.log(`🎯 Selected: ${msg} → index ${index} → ${session.last_results[index]?.product_name}`);

      const sessionProduct = session.last_results[index];

      if (!sessionProduct) {
        const max = session.last_results.length;
        twiml.message(`⚠️ Invalid selection.\n\nPlease choose a number between *1* and *${max}*`);
        return sendTwiml(res, twiml);
      }

      const { data: freshProduct, error: fetchError } = await supabase
        .from("products")
        .select("*")
        .eq("product_name", sessionProduct.product_name)
        .maybeSingle();

      console.log("🔄 Fresh product fetched:", freshProduct?.product_name);
      console.log("❗ Fetch error:", fetchError ? fetchError.message : "none");

      if (fetchError || !freshProduct) {
        twiml.message(`⚠️ Product not found. Please search again!`);
        return sendTwiml(res, twiml);
      }

      await saveSelectedProduct(phone, freshProduct.id);
      await sendProductMessage(twiml, freshProduct);
      return sendTwiml(res, twiml);
    }

    // ✅ 5. SEARCH LOGIC FIFTH
    console.log(`🔍 Searching products for: "${msg}"`);

    const { data, error } = await supabase
      .from("products")
      .select("*")
      .or(`product_name.ilike.%${msg}%,category.ilike.%${msg}%,color.ilike.%${msg}%`);

    console.log("📊 Products found:", data ? data.length : 0);
    console.log("❗ Search error:", error ? error.message : "none");

    if (data && data.length > 0) {

      const saved = await saveSession(phone, data);
      if (!saved) {
        console.error("❌ Session could not be saved");
      }

      if (data.length === 1) {
        console.log("✅ Single product — sending directly");
        await saveSelectedProduct(phone, data[0].id);
        await sendProductMessage(twiml, data[0]);

      } else {
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
      console.log("⚠️ No product found for:", msg);
      twiml.message(
        `Sorry, we couldn't find any product matching "${msg}". 😔\n\n` +
        `Try a different keyword!\n` +
        `Example: *Black*, *Jeans*, *XL*`
      );
    }

    return sendTwiml(res, twiml);

  } catch (error) {
    console.error("❌ Error handling message:", error.message);
    res.status(500).end();
  }
});

// 4. Products route
app.get("/products", async (req, res) => {
  try {
    const { data, error } = await supabase.from("products").select("*");

    if (error) return res.status(500).json({ error: error.message });
    if (!data || data.length === 0) return res.status(200).json({ message: "No products found" });

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