require("dotenv").config();


const express = require("express");
const cookieParser = require("cookie-parser");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const voiceRoutes = require("./routes/voice");
const { writeCallLog } = require("./services/logs");
const {
  searchShopifyProducts,
  searchShopifyOrders,
} = require("./services/shopify");

console.log("SHOPIFY IMPORT:", {
  searchShopifyProducts: typeof searchShopifyProducts,
  searchShopifyOrders: typeof searchShopifyOrders,
});

const { createTransferService } = require("./services/twilioTransfer");

const twilio = require("twilio");

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const HUMAN_PHONE_NUMBER = process.env.HUMAN_PHONE_NUMBER;
const transferCallToHuman = createTransferService(
  twilioClient,
  HUMAN_PHONE_NUMBER
);

const systemPrompt = fs.readFileSync("./Prompt-Barracuda.txt", "utf8");

function loadKnowledgeFolder(folderPath) {
  const files = fs.readdirSync(folderPath).filter((file) => file.endsWith(".txt"));
  return files
    .map((file) => {
      const content = fs.readFileSync(path.join(folderPath, file), "utf8");
      return `\n\n===== ${file} =====\n${content}`;
    })
    .join("\n");
}

const knowledgeBase = loadKnowledgeFolder("./knowledge");

const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime?model=gpt-realtime";

const app = express();
const PORT = 3000;
app.use(cookieParser());
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use("/public", express.static("public"));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Auth dashboard
function dashboardAuth(req, res, next) {
  const pwd = req.cookies?.dashPwd;
  if (pwd === process.env.DASHBOARD_PASSWORD) return next();
  res.send(`
    <form method="POST" action="/dashboard-login" style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:#0a0c10;gap:12px;">
      <input name="pwd" type="password" placeholder="Mot de passe" autofocus
        style="padding:12px 20px;border-radius:8px;border:1px solid #1e2230;background:#111318;color:#e8eaf0;font-size:14px;width:260px;"/>
      <button type="submit"
        style="padding:12px 20px;border-radius:8px;border:none;background:#00e5ff;color:#0a0c10;font-weight:700;cursor:pointer;width:260px;">
        Entrer
      </button>
    </form>
  `);
}
/* =========================
   SERVER
========================= */

app.post("/dashboard-login", (req, res) => {
  const pwd = req.body.pwd;
  if (pwd === process.env.DASHBOARD_PASSWORD) {
    res.cookie("dashPwd", pwd, { httpOnly: true, maxAge: 86400000 }); // 24h
    res.redirect("/dashboard");
  } else {
    res.redirect("/dashboard");
  }
});

app.get("/dashboard", dashboardAuth, (req, res) => {
  console.log("DASHBOARD ROUTE HIT");

  try {
    const logFiles = fs.readdirSync("./logs").filter(f => f.endsWith(".json"));
    const logs = logFiles.map((file) => {
      const raw = fs.readFileSync(path.join("./logs", file), "utf8");
      return JSON.parse(raw);
    });

    const totalCalls = logs.length;
    const transferredCalls = logs.filter((log) =>
      log.events?.some((e) => e.type === "transfer_requested")
    ).length;
    const avgDuration =
      logs.reduce((sum, log) => sum + (log.durationSeconds || 0), 0) / (logs.length || 1);

    res.render("dashboard", { totalCalls, transferredCalls, avgDuration, logs });
  } catch (err) {
    console.error("DASHBOARD ERROR:", err);
    res.status(500).send("Erreur dashboard: " + err.message);
  }
});

const server = app.listen(PORT, () => {
  console.log(`Serveur lancé sur http://localhost:${PORT}`);
});

app.use("/", voiceRoutes);    
/* =========================
   WEBSOCKET TWILIO
========================= */

const wss = new WebSocket.Server({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  let isFrench = true;
  let aiSocket = null;

  console.log("Twilio connecté");
  console.log("REQ URL WEBSOCKET:", req.url);

  const callId = Date.now().toString();
  const callLog = {
    callId,
    startedAt: new Date().toISOString(),
    endedAt: null,
    durationSeconds: null,
    events: [],
    messages: [],
    shopifySearches: [],
    shopifyOrderSearches: [],
    errors: [],
  };

  console.log("Call ID:", callId);

  let streamSid = null;
  let callSid = null;
  let pendingTransfer = false;
  let isInterrupted = false;
  let currentAiItemId = null;
  let currentAudioDurationMs = 0;

  /* =========================
     MESSAGES TWILIO
  ========================= */

  ws.on("message", (msg) => {
    const data = JSON.parse(msg);

    if (data.event === "start") {
      const languageParam = data.start.customParameters?.language || "fr";
      isFrench = languageParam !== "en";
      streamSid = data.start.streamSid;
      callSid = data.start.callSid;

      console.log("Appel commencé");
      console.log("LANGUE PARAM:", languageParam);
      console.log("IS FRENCH:", isFrench);
      console.log("Stream SID:", streamSid);
      console.log("Call SID:", callSid);

      // ✅ OpenAI démarre ICI, après avoir reçu isFrench et streamSid
      initOpenAI();
    }

    if (data.event === "media") {
      if (aiSocket && aiSocket.readyState === WebSocket.OPEN) {
        aiSocket.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: data.media.payload,
        }));
      }
    }
  });

  /* =========================
     INIT OPENAI
  ========================= */

  function initOpenAI() {
    aiSocket = new WebSocket(OPENAI_REALTIME_URL, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });

    aiSocket.on("open", () => {
      console.log("OpenAI connecté");

      aiSocket.send(JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["text", "audio"],
          voice: "ash",
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",

          input_audio_transcription: {
            model: "gpt-4o-mini-transcribe",
          },

          turn_detection: {
            type: "server_vad",
            threshold: 0.7,
            prefix_padding_ms: 500,
            silence_duration_ms: 1200,
            create_response: true,
          },

          tools: [
            {
              type: "function",
              name: "search_shopify_products",
              description: "Cherche des produits dans l'inventaire Shopify. Appelle cette fonction dès que le client demande un produit, un prix, ou si quelque chose est disponible.",
              parameters: {
                type: "object",
                properties: {
                  query: { type: "string", description: "Terme de recherche ex: chlore, algaecide, filtre" },
                },
                required: ["query"],
              },
            },
            {
              type: "function",
              name: "search_shopify_orders",
              description: "Cherche une commande Shopify par numéro de commande.",
              parameters: {
                type: "object",
                properties: {
                  query: { type: "string", description: "Numéro de commande ex: #1045" },
                },
                required: ["query"],
              },
            },
          ],

          tool_choice: "auto",

          instructions: `
LANGUE FORCÉE : ${isFrench ? "Cette conversation est en FRANÇAIS. Tu dois parler uniquement en français, peu importe ce que dit le client." : "This conversation is in ENGLISH. You must speak English only, no matter what the client says."}

${systemPrompt}

BASE DE CONNAISSANCE :
${knowledgeBase}

LANGUE :
- La langue de l'appel est déjà choisie avant le début de la conversation.
- Tu dois parler uniquement dans cette langue.
- Ne change jamais de langue pendant l'appel.
- Ne mélange jamais français et anglais.

STYLE TÉLÉPHONE :
- Réponds court.
- Parle naturellement comme un humain.
- Une question à la fois.
- Ne lis jamais de longs paragraphes.
- Maximum 2 à 3 phrases par réponse, sauf si le client demande plus de détails.
- Après une question, arrête-toi immédiatement et attends la réponse du client.
- Ne pose jamais une question et sa réponse dans le même message.

INTERDICTION :
- Ne dis jamais : "Voulez-vous que je vous explique ?" puis continuer à expliquer.
- Ne dis jamais : "Voulez-vous en savoir plus ?" puis continuer à expliquer.
- Exemple interdit : "Voulez-vous savoir comment tester le pH ? Pour tester le pH..."
- Exemple correct : "Voulez-vous que je vous explique comment tester le pH ?"

SHOPIFY :
- Si le client cherche à acheter, demande un prix, demande si un produit est disponible, ou mentionne qu'il veut un produit précis, appelle search_shopify_products.
- Si le client pose une question de conseil général, réponds d'abord brièvement, sans vendre immédiatement.
- Après un conseil, tu peux proposer doucement : "Je peux aussi vérifier ce qu'on a en stock si vous voulez."
- Utilise un terme de recherche simple : "chlore", "pH plus", "algaecide", "filtre", etc.
- Si plusieurs produits sont retournés, propose maximum 2 ou 3 options avec le nom, le prix et le stock.
- Si un seul produit est retourné, annonce-le simplement avec le prix et le stock.
- Ne récite pas toute la liste si ce n'est pas nécessaire.
- Ne jamais inventer de stock.
- Ne jamais inventer de prix.
- Si aucun produit n'est trouvé, dis-le simplement et propose de passer en magasin ou de parler à quelqu'un.
- Garde un ton naturel, aidant et non vendeur.
- Si le client répond "oui", "yes", "ok" après une proposition de produit, c'est une CONFIRMATION D'ACHAT.
- Après une confirmation d'achat, dis UNIQUEMENT : "Parfait ! Venez le chercher en magasin au 110 Georges, à Gatineau, secteur Encan Masson !" (ou en anglais si le client parle anglais).
- Ne propose JAMAIS d'autres produits après une confirmation.
- Ne pose JAMAIS de question de suivi après une confirmation.
- Ne fais JAMAIS une nouvelle recherche Shopify après une confirmation.
- Ne récite pas d'autres produits. La conversation sur ce produit est terminée.

COMMANDES SHOPIFY :
- Tu as accès aux commandes Shopify avec la fonction search_shopify_orders.
- Si le client veut suivre une commande, connaître le statut d'une commande, savoir où est sa commande, ou donne un numéro de commande, appelle search_shopify_orders.
- Si le client donne un numéro de commande, cherche avec ce numéro, exemple : "#1045".
- Ne dis jamais que tu n'as pas accès aux commandes.
- Si une commande n'est pas trouvée, dis simplement que tu ne la trouves pas avec l'information donnée.
- Ne cherche JAMAIS une commande sans information précise.
- Tu dois avoir un numéro de commande complet.
- Si l'information est incomplète, demande plus de détails avant d'appeler search_shopify_orders.
- Ne jamais deviner une commande.
- Ne jamais utiliser une recherche vague.
- Ne jamais appeler search_shopify_orders sans numéro de commande complet.
Si la commande est trouvée mais tracking est vide, dis :
"J’ai trouvé votre commande. Elle est présentement non expédiée / en traitement, donc il n’y a pas encore de numéro de suivi."

TRANSFERT HUMAIN :
- si le client demande à parler à quelqu'un, à un humain, à un employé ou demande un transfert, appelle immédiatement la fonction transfer_call_to_human.
- Dis TOUJOURS avant le transfert : "Je vais vous transférer à quelqu'un de l'équipe. Un instant s'il vous plaît."
- Si le client dit "je veux parler à quelqu'un", "je veux parler à un humain", "transférez-moi", "je veux un employé", ou toute phrase similaire, appelle immédiatement la fonction transfer_call_to_human.
- Ne réponds pas avec du texte avant d'appeler la fonction.
- Ne pose aucune question de clarification.
- N'explique rien.

ADRESSE :
- Français : Nous sommes situés au 110 Georges, à Gatineau, secteur Encan Masson.
- English : We're located at 110 Georges in Gatineau, in the Encan Masson area.
`,
        },
      }));

      // ✅ streamSid et isFrench sont garantis corrects ici
      const introText = isFrench
        ? "L'appel commence. Présente-toi avec cette phrase exacte : Bonjour, ici Barry de Piscine Barracuda. Comment puis-je vous aider aujourd'hui ?"
        : "The call starts. Introduce yourself with this exact phrase: Hi, this is Barry from Barracuda Pools. How can I help you today?";

      aiSocket.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: introText }],
        },
      }));

      aiSocket.send(JSON.stringify({ type: "response.create" }));
    });

    /* =========================
       AUDIO OPENAI → TWILIO
    ========================= */

    aiSocket.on("message", async (msg) => {
      const response = JSON.parse(msg);

      console.log("OPENAI EVENT:", response.type, response.name || "");
      if (response.type === "error") {
  console.log("OPENAI ERROR FULL:", JSON.stringify(response.error, null, 2));
}

      if (response.type === "input_audio_buffer.speech_started") {
        console.log("🛑 INTERRUPTION — speech started");
        currentAudioDurationMs = 0;
        isInterrupted = true;

        if (streamSid) {
          ws.send(JSON.stringify({ event: "clear", streamSid }));
          console.log("🔇 Twilio audio cleared");
        }

        if (currentAiItemId) {
          aiSocket.send(JSON.stringify({
            type: "conversation.item.truncate",
            item_id: currentAiItemId,
            content_index: 0,
            audio_end_ms: currentAudioDurationMs,
          }));
          console.log(`✂️ Truncate → item ${currentAiItemId} à ${currentAudioDurationMs}ms`);
        }
      }

      if (response.type === "input_audio_buffer.speech_stopped") {
        console.log("🎙️ speech stopped — reset interruption");
        isInterrupted = false;
      }

      if (response.type === "response.output_item.added") {
        currentAiItemId = response.item?.id ?? null;
        currentAudioDurationMs = 0;
        isInterrupted = false;
        console.log("🎯 Nouvel item AI:", currentAiItemId);
      }

      if (response.type === "response.done" && pendingTransfer) {
        pendingTransfer = false;
        console.log("TRANSFERT APRÈS RESPONSE DONE");
        await new Promise((resolve) => setTimeout(resolve, 4500));
        await transferCallToHuman(callSid);
        return;
      }

      if (response.type === "conversation.item.input_audio_transcription.completed") {
        const userText = response.transcript || "";
        const normalizedText = userText.toLowerCase();

        callLog.messages.push({
          role: "user",
          text: userText,
          time: new Date().toISOString(),
        });

        console.log("USER LOGGED:", userText);

        const wantsHuman =
          normalizedText.includes("parler à quelqu") ||
          normalizedText.includes("parler a quelqu") ||
          normalizedText.includes("parler à un humain") ||
          normalizedText.includes("parler a un humain") ||
          normalizedText.includes("parler à une personne") ||
          normalizedText.includes("parler a une personne") ||
          normalizedText.includes("je veux un humain") ||
          normalizedText.includes("je veux quelqu") ||
          normalizedText.includes("humain") ||
          normalizedText.includes("transfert") ||
          normalizedText.includes("transférer") ||
          normalizedText.includes("transferer") ||
          normalizedText.includes("parler à unemployé") ||
          normalizedText.includes("talk to an employe");

        console.log("DEBUG wantsHuman:", wantsHuman);
        console.log("DEBUG userText:", userText);
        console.log("DEBUG normalizedText:", normalizedText);

        if (wantsHuman) {
          console.log("TRANSFERT DÉTECTÉ PAR TEXTE");

          callLog.events.push({
            type: "transfer_requested",
            reason: "client demande un humain",
            time: new Date().toISOString(),
          });

          writeCallLog(callId, callLog);
          pendingTransfer = true;

          aiSocket.send(JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: "Réponds uniquement avec cette phrase exacte, sans rien ajouter : Je vais vous transférer à quelqu'un de l'équipe. Un instant s'il vous plaît.",
                },
              ],
            },
          }));

          aiSocket.send(JSON.stringify({ type: "response.create" }));
          return;
        }

        try {
          writeCallLog(callId, callLog);
        } catch (err) {
          console.error("LOG WRITE ERROR USER:", err);
        }
      }

      if (response.type === "response.audio_transcript.delta") {
        if (!callLog.currentAssistantText) callLog.currentAssistantText = "";
        callLog.currentAssistantText += response.delta || "";
      }

      if (response.type === "response.audio_transcript.done") {
        const finalText =
          response.transcript ||
          response.text ||
          callLog.currentAssistantText ||
          "";

        callLog.messages.push({
          role: "assistant",
          text: finalText,
          time: new Date().toISOString(),
        });

        console.log("AI LOGGED:", finalText);
        callLog.currentAssistantText = "";
        writeCallLog(callId, callLog);
      }

      if (response.type === "response.audio.delta") {
        if (!streamSid) return;

        const payloadBytes = Math.floor((response.delta?.length ?? 0) * 0.75);
        currentAudioDurationMs += payloadBytes / 8;

        ws.send(JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: response.delta },
        }));
      }

      if (response.type === "response.function_call_arguments.done") {
        console.log("FUNCTION CALL:", response.name, response.call_id, response.arguments);

        const args = JSON.parse(response.arguments);

        if (response.name === "search_shopify_products") {
          const shopifyData = await searchShopifyProducts(args.query);

          callLog.shopifySearches.push({
            query: args.query,
            time: new Date().toISOString(),
            raw: shopifyData,
          });

          const products = shopifyData?.data?.products?.edges || [];
          let result;

          if (products.length === 0) {
            result = { found: false, message: "Aucun produit trouvé." };
          } else {
            result = {
              found: true,
              products: products.map(({ node: product }) => ({
                title: product.title,
                totalStock: product.totalInventory,
                variants: product.variants.edges.map(({ node: variant }) => ({
                  format: variant.title !== "Default Title" ? variant.title : null,
                  price: `${variant.price} CAD`,
                  stock: variant.inventoryQuantity,
                })),
              })),
            };
          }

        aiSocket.send(JSON.stringify({
  type: "conversation.item.create",
  item: {
    type: "function_call_output",
    call_id: response.call_id,
    output: JSON.stringify(result),
  },
}));

aiSocket.send(JSON.stringify({
  type: "response.create",
  response: {
    modalities: ["audio", "text"],
    instructions: `
Réponds maintenant au client avec les informations de la commande.
Sois court et naturel.
Si la commande est non expédiée, dis qu'elle n'a pas encore été envoyée.
Si tracking est vide, dis qu'il n'y a pas encore de numéro de suivi.
`
  }
}));

return;
 }
        if (response.name === "search_shopify_orders") {
          const query = args.query?.trim();
          const isValidOrderSearch = query && query.startsWith("#");

          if (!isValidOrderSearch) {
            aiSocket.send(JSON.stringify({
              type: "conversation.item.create",
              item: {
                type: "function_call_output",
                call_id: response.call_id,
                output: JSON.stringify({
                  found: false,
                  message: "Information insuffisante pour rechercher une commande. Demande le numéro de commande, le courriel ou le téléphone.",
                }),
              },
            }));

            aiSocket.send(JSON.stringify({ type: "response.create" }));
            return;
          }

          const shopifyData = await searchShopifyOrders(query);

          callLog.shopifyOrderSearches.push({
            query,
            time: new Date().toISOString(),
            raw: shopifyData,
          });

          writeCallLog(callId, callLog);
          console.log("SHOPIFY ORDER SEARCH:", JSON.stringify(shopifyData, null, 2));

          const orders = shopifyData?.data?.orders?.edges || [];
          let result;

          if (orders.length === 0) {
            result = {
              found: false,
              message: "Aucune commande trouvée. Je vais vous transférer à quelqu'un de l'équipe. Un instant s'il vous plaît.",
            };

            pendingTransfer = true;

            aiSocket.send(JSON.stringify({
              type: "conversation.item.create",
              item: {
                type: "function_call_output",
                call_id: response.call_id,
                output: JSON.stringify(result),
              },
            }));

            aiSocket.send(JSON.stringify({ type: "response.create" }));
            return;
          } else {
            result = {
              found: true,
              orders: orders.map(({ node: order }) => ({
                orderNumber: order.name,
                customerName: order.customer
                  ? `${order.customer.firstName || ""} ${order.customer.lastName || ""}`.trim()
                  : null,
                email: order.email,
                phone: order.phone,
                paymentStatus: order.displayFinancialStatus,
                fulfillmentStatus: order.displayFulfillmentStatus,
                createdAt: order.createdAt,
                total: `${order.totalPriceSet.shopMoney.amount} ${order.totalPriceSet.shopMoney.currencyCode}`,
                tracking: order.fulfillments.flatMap((fulfillment) =>
                  fulfillment.trackingInfo.map((tracking) => ({
                    company: tracking.company,
                    number: tracking.number,
                    url: tracking.url,
                  }))
                ),
              })),
            };
          }

          aiSocket.send(JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: response.call_id,
              output: JSON.stringify(result),
            },
          }));

          aiSocket.send(JSON.stringify({ type: "response.create" }));
          return;
        }
      }
    }); // ferme aiSocket.on("message")

    aiSocket.on("error", (err) => {
      console.error("Erreur OpenAI:", err);
    });

  } // ferme initOpenAI

  /* =========================
     CLOSE / ERROR
  ========================= */

  ws.on("close", () => {
    try {
      callLog.endedAt = new Date().toISOString();
      callLog.durationSeconds = Math.round(
        (new Date(callLog.endedAt) - new Date(callLog.startedAt)) / 1000
      );
      callLog.events.push({ type: "call_ended", time: new Date().toISOString() });
      writeCallLog(callId, callLog);
    } catch (err) {
      console.error("Erreur log fermeture:", err.message);
    }

    console.log("Twilio fermé");

    if (aiSocket && aiSocket.readyState === WebSocket.OPEN) {
      aiSocket.close();
    }
  });

  ws.on("error", (err) => {
    console.error("Erreur Twilio:", err.message);
  });

}); // ferme wss.on("connection")



