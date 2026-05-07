
require("dotenv").config();

const express = require("express");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

const systemPrompt = fs.readFileSync(
  "./Prompt-Barracuda.txt",
  "utf8"
);

function loadKnowledgeFolder(folderPath) {
  const files = fs
    .readdirSync(folderPath)
    .filter((file) => file.endsWith(".txt"));

  return files
    .map((file) => {
      const content = fs.readFileSync(
        path.join(folderPath, file),
        "utf8"
      );

      return `\n\n===== ${file} =====\n${content}`;
    })
    .join("\n");
}

const knowledgeBase = loadKnowledgeFolder("./knowledge");



const OPENAI_REALTIME_URL =
  "wss://api.openai.com/v1/realtime?model=gpt-realtime";

const app = express();
const PORT = 3000;

app.use(express.json());

/* =========================
   SHOPIFY (VERSION SIMPLE)
========================= */
async function searchShopifyProducts(query) {
  const response = await fetch(
    `https://${process.env.SHOPIFY_DOMAIN}/admin/api/2026-04/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN,
      },
      body: JSON.stringify({
        query: `
          query SearchProducts($query: String!) {
            products(first: 5, query: $query) {
              edges {
                node {
                  title
                  totalInventory
                  variants(first: 1) {
                    edges {
                      node {
                        price
                        inventoryQuantity
                      }
                    }
                  }
                }
              }
            }
          }
        `,
        variables: { query },
      }),
    }
  );

  return await response.json();
}

/* =========================
   ROUTE TWILIO
========================= */

app.post("/voice", (req, res) => {
  const twiml = `
<Response>
  <Connect>
    <Stream url="wss://stopping-absurd-nuzzle.ngrok-free.dev/ws" />
  </Connect>
</Response>`;
  res.type("text/xml");
  res.send(twiml);
});

/* =========================
   SERVER
========================= */

const server = app.listen(PORT, () => {
  console.log(`Serveur lancé sur http://localhost:${PORT}`);
});

/* =========================
   WEBSOCKET TWILIO
========================= */

const wss = new WebSocket.Server({ server, path: "/ws" });

wss.on("connection", (ws) => {
  console.log("Twilio connecté");

  let streamSid = null;

  const aiSocket = new WebSocket(OPENAI_REALTIME_URL, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  /* =========================
     OPENAI CONNECTÉ
  ========================= */

  aiSocket.on("open", () => {
    console.log("OpenAI connecté");

    aiSocket.send(
      JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["text", "audio"],
          voice: "ash",
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          turn_detection: {
            type: "server_vad",
            threshold: 0.9,
            prefix_padding_ms: 500,
            silence_duration_ms: 1200,
          },
          
          instructions: `
${systemPrompt}

BASE DE CONNAISSANCE :
${knowledge1}

RÈGLES IMPORTANTES POUR LA VOIX :

LANGUE :
- Tu peux parler français et anglais.
- Choisis la langue principale du client dans les premières secondes de l’appel.
- Une fois la langue détectée, garde cette langue pour toute la conversation.
- Si la conversation commence en français, reste entièrement en français.
- Si la conversation commence en anglais, reste entièrement en anglais.
- Ne change pas de langue pour des mots isolés comme "okay", "yeah", "perfect", "thanks".
- Change de langue seulement si le client parle clairement dans l’autre langue pendant plusieurs phrases.
- Ne mélange jamais français et anglais dans une même réponse.
- Le message d’accueil peut être bilingue seulement au début de l’appel.
- Si le client parle anglais, toutes les informations doivent être données en anglais, incluant l’adresse, les heures d’ouverture, les services et les explications.
- Ne traduis pas seulement la réponse principale : adapte toute la phrase dans la langue du client.

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
- Si le client demande un produit, utilise search_shopify_products.
- Ne jamais inventer de stock.
- Ne jamais inventer de prix.
- Si tu n'es pas certain, transfère à un humain.

ADRESSE :
- Français : Nous sommes situés au 110 Georges, à Gatineau, secteur Encan Masson.
- English : We’re located at 110 Georges in Gatineau, in the Encan Masson area.
`,
          tools: [
            {
              type: "function",
              name: "search_shopify_products",
              parameters: {
                type: "object",
                properties: {
                  query: { type: "string" },
                },
                required: ["query"],
              },
            },
          ],
        },
      })
    );

    // INTRO CORRECTE
    setTimeout(() => {
      aiSocket.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text:
                  "L'appel commence. Présente-toi avec cette phrase exacte : Bonjour, ici Barry de Piscine Barracuda. Hi, this is Barry from Barracuda Pools. How can i help you today?",
              },
            ],
          },
        })
      );

      aiSocket.send(JSON.stringify({ type: "response.create" }));
    }, 500);
  });

  /* =========================
     AUDIO TWILIO → OPENAI
  ========================= */

  ws.on("message", (msg) => {
    const data = JSON.parse(msg);

    if (data.event === "start") {
      streamSid = data.start.streamSid;
      console.log("Appel commencé");
    }

    if (data.event === "media") {
      if (aiSocket.readyState === WebSocket.OPEN) {
        aiSocket.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: data.media.payload,
          })
        );
      }
    }
  });

  /* =========================
     AUDIO OPENAI → TWILIO
  ========================= */

  aiSocket.on("message", async (msg) => {
    const response = JSON.parse(msg);

    if (response.type === "response.audio.delta" && streamSid) {
      ws.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: response.delta },
        })
      );
    }

    if (response.type === "response.function_call_arguments.done") {
      const args = JSON.parse(response.arguments);

      const shopifyData = await searchShopifyProducts(args.query);
      const product =
        shopifyData?.data?.products?.edges?.[0]?.node;

      let result;

      if (!product) {
        result = "Aucun produit trouvé.";
      } else {
        const variant = product.variants.edges[0]?.node;

        result = {
          title: product.title,
          price: `${variant?.price} CAD`,
          stock: variant?.inventoryQuantity,
        };
      }

      aiSocket.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: response.call_id,
            output: JSON.stringify(result),
          },
        })
      );

      aiSocket.send(JSON.stringify({ type: "response.create" }));
    }
  });

  /* =========================
     CLOSE / ERROR
  ========================= */

  ws.on("close", () => {
    console.log("Twilio fermé");

    if (aiSocket.readyState === WebSocket.OPEN) {
      aiSocket.close();
    }
  });

  aiSocket.on("close", () => {
    console.log("OpenAI fermé");
  });

  aiSocket.on("error", (err) => {
    console.error("Erreur OpenAI:", err.message);
  });

  ws.on("error", (err) => {
    console.error("Erreur Twilio:", err.message);
  });
});