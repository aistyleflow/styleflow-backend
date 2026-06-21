const express = require("express");
const twilio = require("twilio");
const { createClient } = require("@supabase/supabase-js");

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const GREETINGS = ["hi", "hello", "hey", "helo", "hii", "start", "namaste"];

// ✅ Format date — Indian timezone
function formatDate(dateString) {
  const date = new Date(dateString);
  return date.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Asia/Kolkata'
  });
}

// ✅ Status emoji
function getStatusEmoji(status) {
  switch (status) {
    case 'pending':   return '⏳'
    case 'confirmed': return '✅'
    case 'shipped':   return '🚚'
    case 'delivered': return '📦'
    case 'cancelled': return '❌'
    default:          return '📋'
  }
}

// ✅ Fetch order items with product names
async function getOrderItems(orderId) {
  const { data: orderItems } = await supabase
    .from('order_items')
    .select('*, products(product_name, price)')
    .eq('order_id', orderId)

  if (!orderItems || orderItems.length === 0) return ''

  let itemsText = ''
  let total = 0

  for (const item of orderItems) {
    const name = item.products?.product_name || 'Unknown'
    const price = item.products?.price || 0
    const itemTotal = price * item.quantity
    total += itemTotal
    itemsText += `   • ${name} × ${item.quantity} = ₹${itemTotal}\n`
  }

  itemsText += `   💰 Total: ₹${total}`
  return itemsText
}

app.get("/", (req, res) => {
  res.send("StyleFlow is running!");
});

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

async function isImageAccessible(url) {
  try {
    const response = await fetch(url, { method: "HEAD" });
    return response.ok;
  } catch (err) {
    return false;
  }
}

async function sendWhatsAppMessage(to, messageBody) {
  try {
    const message = await client.messages.create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: to,
      body: messageBody
    });
    console.log("✅ Message sent — SID:", message.sid);
    return true;
  } catch (err) {
    console.error("❌ REST API send error:", err.message);
    return false;
  }
}

async function sendProductMessage(twiml, product) {
  const message = twiml.message();
  message.body(
    `🛍️ *Product Details*\n\n` +
    `📦 Product: ${product.product_name}\n` +
    `💰 Price: ₹${product.price}\n` +
    `📦 Stock: ${product.stock}\n` +
    `📐 Sizes: ${product.size || 'Free Size'}\n` +
    `🎨 Color: ${product.color}\n\n` +
    `💬 Reply *ADD* to add to cart\n` +
    `🛒 Reply *CART* to view your cart`
  );
  if (product.image_url) {
    const accessible = await isImageAccessible(product.image_url);
    if (accessible) message.media(product.image_url);
  }
}

async function saveSession(phone, data) {
  try {
    const { data: existing } = await supabase
      .from("user_sessions")
      .select("phone_number")
      .eq("phone_number", phone)
      .maybeSingle();

    if (existing) {
      await supabase
        .from("user_sessions")
        .update({ last_results: data })
        .eq("phone_number", phone);
    } else {
      await supabase
        .from("user_sessions")
        .insert({ phone_number: phone, last_results: data });
    }
    return true;
  } catch (err) {
    return false;
  }
}

async function saveSelectedProduct(phone, productId) {
  try {
    const { data: existing } = await supabase
      .from("user_sessions")
      .select("phone_number")
      .eq("phone_number", phone)
      .maybeSingle();

    if (existing) {
      await supabase
        .from("user_sessions")
        .update({ selected_product_id: productId })
        .eq("phone_number", phone);
    } else {
      await supabase
        .from("user_sessions")
        .insert({ phone_number: phone, selected_product_id: productId });
    }
    return true;
  } catch (err) {
    return false;
  }
}

function sendTwiml(res, twiml) {
  const xml = twiml.toString();
  console.log("📤 Final TwiML:", xml);
  res.setHeader("Content-Type", "text/xml");
  res.status(200).send(xml);
}

app.post("/whatsapp", async (req, res) => {
  try {
    const body = req.body;
    if (!body) return res.status(400).end();

    const phone = body.From;
    const msg = body.Body ? body.Body.trim() : "";
    const msgLower = msg.toLowerCase();
    const msgUpper = msg.toUpperCase();

    console.log("=================================");
    console.log("📩 New message received");
    console.log("PHONE:", phone);
    console.log("MESSAGE:", msg);
    console.log("=================================");

    if (!phone || !msg) return res.status(400).end();

    const twiml = new twilio.twiml.MessagingResponse();

    const { data: session } = await supabase
      .from("user_sessions")
      .select("*")
      .eq("phone_number", phone)
      .maybeSingle();

    console.log("📋 checkout_step:", session?.checkout_step || "none");

    // ✅ 1. GREETING
    if (GREETINGS.includes(msgLower)) {
      console.log("👋 Greeting received");
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
        `📦 Type *ORDER STATUS* to check latest order\n` +
        `📋 Type *ORDER HISTORY* to see all orders\n\n` +
        `Happy Shopping! 🎉`
      );
      return;
    }

    // ✅ 2. CHECKOUT STEP — NAME
    if (session?.checkout_step === "name") {
      await supabase
        .from("user_sessions")
        .update({ customer_name: msg, checkout_step: "address" })
        .eq("phone_number", phone);
      twiml.message(`✅ Name saved: *${msg}*\n\n📍 Please enter your delivery address:`);
      return sendTwiml(res, twiml);
    }

    // ✅ 3. CHECKOUT STEP — ADDRESS
    if (session?.checkout_step === "address") {
      const { data: cartItems } = await supabase
        .from("cart").select("*").eq("phone_number", phone);

      if (!cartItems || cartItems.length === 0) {
        await supabase
          .from("user_sessions")
          .update({ checkout_step: null })
          .eq("phone_number", phone);
        twiml.message(`⚠️ Your cart is empty!`);
        return sendTwiml(res, twiml);
      }

      const { data: order, error: orderError } = await supabase
        .from("orders")
        .insert({
          phone_number: phone,
          customer_name: session.customer_name,
          customer_address: msg,
          status: "pending"
        })
        .select()
        .single();

      if (orderError || !order) {
        twiml.message(`⚠️ Could not place order. Please try again!`);
        return sendTwiml(res, twiml);
      }

      let orderTotal = 0;
      let orderSummary = "";
      let storeId = null;

      for (const item of cartItems) {
        const { data: product } = await supabase
          .from("products").select("*")
          .eq("id", item.product_id).maybeSingle();

        if (product) {
          if (!storeId && product.store_id) storeId = product.store_id;
          await supabase.from("order_items").insert({
            order_id: order.id,
            product_id: item.product_id,
            quantity: item.quantity
          });
          const itemTotal = product.price * item.quantity;
          orderTotal += itemTotal;
          orderSummary += `• ${product.product_name}${item.size ? ` (${item.size})` : ''} × ${item.quantity} = ₹${itemTotal}\n`;
        }
      }

      if (storeId) {
        await supabase.from("orders").update({ store_id: storeId }).eq("id", order.id);
      }

      await supabase.from("cart").delete().eq("phone_number", phone);
      await supabase
        .from("user_sessions")
        .update({ checkout_step: null, customer_address: msg })
        .eq("phone_number", phone);

      twiml.message(
        `✅ *Order Placed Successfully!*\n\n` +
        `🧾 *Order Summary:*\n${orderSummary}\n` +
        `💰 *Total: ₹${orderTotal}*\n\n` +
        `👤 Name: ${session.customer_name}\n` +
        `📍 Address: ${msg}\n\n` +
        `🆔 Order ID: ${order.id}\n` +
        `🕐 ${formatDate(order.created_at)}\n\n` +
        `📦 Type *ORDER STATUS* to track your order\n\n` +
        `Thank you for shopping with *StyleFlow*! 🎉`
      );
      return sendTwiml(res, twiml);
    }

    // ✅ 4. SIZE STEP
    if (session?.checkout_step === "size") {
      const { data: product } = await supabase
        .from("products").select("*")
        .eq("id", session.selected_product_id).maybeSingle();

      if (!product) {
        await supabase
          .from("user_sessions")
          .update({ checkout_step: null })
          .eq("phone_number", phone);
        twiml.message(`⚠️ Product not found. Please search again!`);
        return sendTwiml(res, twiml);
      }

      const availableSizes = product.size
        ? product.size.split(',').map(s => s.trim().toUpperCase())
        : [];
      const enteredSize = msg.trim().toUpperCase();

      if (availableSizes.length > 0 && !availableSizes.includes(enteredSize)) {
        twiml.message(
          `⚠️ *"${msg}"* is not a valid size.\n\n` +
          `Please choose from: *${product.size}*\n\n` +
          `Type your size (e.g. *M* or *L*)`
        );
        return sendTwiml(res, twiml);
      }

      const finalSize = availableSizes.length > 0 ? enteredSize : msg.trim();

      const { data: existingCart } = await supabase
        .from("cart").select("*")
        .eq("phone_number", phone)
        .eq("product_id", session.selected_product_id)
        .maybeSingle();

      if (existingCart) {
        await supabase
          .from("cart")
          .update({ quantity: existingCart.quantity + 1, size: finalSize })
          .eq("id", existingCart.id);

        twiml.message(
          `✅ *Cart Updated!*\n\n` +
          `📦 ${product.product_name}\n` +
          `📐 Size: *${finalSize}*\n` +
          `💰 ₹${product.price}\n` +
          `🔢 Quantity: ${existingCart.quantity + 1}\n\n` +
          `🛒 Type *CART* to view\n` +
          `✅ Type *CHECKOUT* to order`
        );
      } else {
        await supabase.from("cart").insert({
          phone_number: phone,
          product_id: session.selected_product_id,
          quantity: 1,
          size: finalSize
        });

        twiml.message(
          `✅ *Added to Cart!*\n\n` +
          `📦 ${product.product_name}\n` +
          `📐 Size: *${finalSize}*\n` +
          `💰 ₹${product.price}\n\n` +
          `🛒 Type *CART* to view\n` +
          `✅ Type *CHECKOUT* to order`
        );
      }

      await supabase
        .from("user_sessions")
        .update({ checkout_step: null })
        .eq("phone_number", phone);

      return sendTwiml(res, twiml);
    }

    // ✅ 5. ORDER STATUS — latest order with product names
    if (
      msgUpper === "ORDER STATUS" ||
      msgUpper === "STATUS" ||
      msgUpper === "MY ORDER"
    ) {
      console.log("📦 ORDER STATUS for:", phone);

      const { data: orders } = await supabase
        .from("orders")
        .select("*")
        .eq("phone_number", phone)
        .order("id", { ascending: false })
        .limit(1)

      if (!orders || orders.length === 0) {
        twiml.message(
          `📦 *No orders found!*\n\n` +
          `You have not placed any orders yet.\n\n` +
          `Search for products to start shopping! 🛍️`
        );
        return sendTwiml(res, twiml);
      }

      const order = orders[0]
      const emoji = getStatusEmoji(order.status)

      // ✅ Fetch product names for this order
      const itemsText = await getOrderItems(order.id)

      twiml.message(
        `📦 *Latest Order Status*\n\n` +
        `🆔 Order ID: #${order.id}\n` +
        `${emoji} Status: *${order.status.toUpperCase()}*\n\n` +
        `🛍️ *Items:*\n${itemsText}\n\n` +
        `👤 Name: ${order.customer_name || 'N/A'}\n` +
        `📍 Address: ${order.customer_address || 'N/A'}\n` +
        `🕐 Ordered: ${formatDate(order.created_at)}\n\n` +
        `📋 Type *ORDER HISTORY* to see all your orders`
      );
      return sendTwiml(res, twiml);
    }

    // ✅ 6. ORDER HISTORY — all orders with full details + product names
    if (
      msgUpper === "ORDER HISTORY" ||
      msgUpper === "MY ORDERS" ||
      msgUpper === "HISTORY"
    ) {
      console.log("📋 ORDER HISTORY for:", phone);

      const { data: orders } = await supabase
        .from("orders")
        .select("*")
        .eq("phone_number", phone)
        .order("id", { ascending: false })

      if (!orders || orders.length === 0) {
        twiml.message(
          `📋 *No order history found!*\n\n` +
          `You have not placed any orders yet.\n\n` +
          `Search for products to start shopping! 🛍️`
        );
        return sendTwiml(res, twiml);
      }

      let reply = `📋 *Your Order History* (${orders.length} order${orders.length > 1 ? 's' : ''})\n\n`;

      for (const order of orders) {
        const emoji = getStatusEmoji(order.status)
        const itemsText = await getOrderItems(order.id) // ✅ product names per order

        reply += `🆔 Order #${order.id}\n`
        reply += `${emoji} Status: *${order.status.toUpperCase()}*\n`
        reply += `🕐 ${formatDate(order.created_at)}\n\n`
        reply += `🛍️ *Items:*\n${itemsText}\n\n`
        reply += `👤 ${order.customer_name || 'N/A'}\n`
        reply += `📍 ${order.customer_address || 'N/A'}\n`
        reply += `─────────────────\n`
      }

      reply += `\n📦 Type *ORDER STATUS* to check latest order`

      twiml.message(reply);
      return sendTwiml(res, twiml);
    }

    // ✅ 7. CHECKOUT COMMAND
    if (msgUpper === "CHECKOUT") {
      const { data: cartCheck } = await supabase
        .from("cart").select("*").eq("phone_number", phone);

      if (!cartCheck || cartCheck.length === 0) {
        twiml.message(`⚠️ Your cart is empty!\n\nSearch for products and type *ADD* first.`);
        return sendTwiml(res, twiml);
      }

      await supabase
        .from("user_sessions")
        .update({ checkout_step: "name" })
        .eq("phone_number", phone);

      twiml.message(
        `🛍️ *Checkout*\n\n` +
        `${cartCheck.length} item${cartCheck.length > 1 ? "s" : ""} in your cart.\n\n` +
        `👤 Please enter your *full name*:`
      );
      return sendTwiml(res, twiml);
    }

    // ✅ 8. ADD COMMAND
    if (msgUpper === "ADD") {
      console.log("🛒 ADD command");

      if (!session?.selected_product_id) {
        twiml.message(
          `⚠️ Please select a product first.\n\n` +
          `Search for a product, select a number, then type *ADD*`
        );
        return sendTwiml(res, twiml);
      }

      const { data: product } = await supabase
        .from("products").select("*")
        .eq("id", session.selected_product_id).maybeSingle();

      if (!product) {
        twiml.message(`⚠️ Product not found. Please search and select again!`);
        return sendTwiml(res, twiml);
      }

      if (product.size && product.size.trim() !== '') {
        await supabase
          .from("user_sessions")
          .update({ checkout_step: "size" })
          .eq("phone_number", phone);

        twiml.message(
          `📐 *Select Size*\n\n` +
          `Product: *${product.product_name}*\n\n` +
          `Available sizes:\n` +
          product.size.split(',').map(s => `• *${s.trim()}*`).join('\n') +
          `\n\nType your size (e.g. *M* or *XL*)`
        );
        return sendTwiml(res, twiml);

      } else {
        const { data: existingCart } = await supabase
          .from("cart").select("*")
          .eq("phone_number", phone)
          .eq("product_id", session.selected_product_id)
          .maybeSingle();

        if (existingCart) {
          await supabase
            .from("cart")
            .update({ quantity: existingCart.quantity + 1 })
            .eq("id", existingCart.id);

          twiml.message(
            `✅ *Cart Updated!*\n\n` +
            `📦 ${product.product_name}\n` +
            `💰 ₹${product.price}\n` +
            `🔢 Quantity: ${existingCart.quantity + 1}\n\n` +
            `🛒 Type *CART* to view\n` +
            `✅ Type *CHECKOUT* to order`
          );
        } else {
          await supabase.from("cart").insert({
            phone_number: phone,
            product_id: session.selected_product_id,
            quantity: 1,
            size: 'Free Size'
          });

          twiml.message(
            `✅ *Added to Cart!*\n\n` +
            `📦 ${product.product_name}\n` +
            `💰 ₹${product.price}\n\n` +
            `🛒 Type *CART* to view\n` +
            `✅ Type *CHECKOUT* to order`
          );
        }
        return sendTwiml(res, twiml);
      }
    }

    // ✅ 9. CART COMMAND
    if (msgUpper === "CART") {
      const { data: cartItems } = await supabase
        .from("cart").select("*").eq("phone_number", phone);

      if (!cartItems || cartItems.length === 0) {
        twiml.message(
          `🛒 Your cart is empty.\n\n` +
          `Search for products!\nExample: Type *Black* or *Jeans*`
        );
        return sendTwiml(res, twiml);
      }

      let reply = `🛒 *Your Cart*\n\n`;
      let total = 0;
      let itemCount = 0;

      for (let i = 0; i < cartItems.length; i++) {
        const { data: product } = await supabase
          .from("products").select("*")
          .eq("id", cartItems[i].product_id).maybeSingle();

        if (product) {
          const itemTotal = product.price * cartItems[i].quantity;
          total += itemTotal;
          itemCount++;
          reply += `${i + 1}. *${product.product_name}*\n`;
          reply += `   📐 Size: ${cartItems[i].size || 'Free Size'}\n`;
          reply += `   💰 ₹${product.price} × ${cartItems[i].quantity} = ₹${itemTotal}\n`;
          reply += `   🎨 Color: ${product.color}\n\n`;
        }
      }

      reply += `─────────────────\n`;
      reply += `🧾 *Total: ₹${total}*\n`;
      reply += `📦 ${itemCount} item${itemCount > 1 ? "s" : ""} in cart\n\n`;
      reply += `✅ Type *CHECKOUT* to place order\n`;
      reply += `🔍 Or search for more products!`;

      twiml.message(reply);
      return sendTwiml(res, twiml);
    }

    // ✅ 10. NUMBER CHECK
    const isNumber = /^[0-9]+$/.test(msg);

    if (isNumber) {
      const index = parseInt(msg) - 1;

      if (!session || !session.last_results) {
        twiml.message(`⚠️ Session expired. Please search again!`);
        return sendTwiml(res, twiml);
      }

      const sessionProduct = session.last_results[index];

      if (!sessionProduct) {
        twiml.message(`⚠️ Invalid selection. Choose between *1* and *${session.last_results.length}*`);
        return sendTwiml(res, twiml);
      }

      const { data: freshProduct } = await supabase
        .from("products").select("*")
        .eq("product_name", sessionProduct.product_name).maybeSingle();

      if (!freshProduct) {
        twiml.message(`⚠️ Product not found. Please search again!`);
        return sendTwiml(res, twiml);
      }

      await saveSelectedProduct(phone, freshProduct.id);
      await sendProductMessage(twiml, freshProduct);
      return sendTwiml(res, twiml);
    }

    // ✅ 11. SEARCH LAST
    console.log(`🔍 Searching: "${msg}"`);

    const { data, error } = await supabase
      .from("products").select("*")
      .or(`product_name.ilike.%${msg}%,category.ilike.%${msg}%,color.ilike.%${msg}%`);

    if (data && data.length > 0) {
      await saveSession(phone, data);

      if (data.length === 1) {
        await saveSelectedProduct(phone, data[0].id);
        await sendProductMessage(twiml, data[0]);
      } else {
        let response = `🛍️ *StyleFlow* — Products matching "${msg}":\n\n`;
        data.forEach((product, index) => {
          response += `${index + 1}. *${product.product_name}*\n`;
          response += `   💰 ₹${product.price}\n`;
          response += `   📦 Stock: ${product.stock}\n`;
          response += `   📐 Sizes: ${product.size || 'Free Size'}\n`;
          response += `   🎨 Color: ${product.color}\n`;
          response += product.image_url ? `   🖼️ Image available\n\n` : `\n`;
        });
        response += `_Reply with a number to see details + image!_`;
        twiml.message(response);
      }
    } else {
      twiml.message(
        `Sorry, no product found for "${msg}". 😔\n\n` +
        `Try: *Black*, *Jeans*, *XL*`
      );
    }

    return sendTwiml(res, twiml);

  } catch (error) {
    console.error("❌ Error:", error.message);
    res.status(500).end();
  }
});

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

app.use((req, res) => {
  res.status(404).send("Route not found");
});

app.use((err, req, res, next) => {
  console.error("❌ Error:", err.stack);
  res.status(500).send("Something went wrong!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 StyleFlow server running on port ${PORT}`);
});