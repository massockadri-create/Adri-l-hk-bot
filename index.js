const express = require("express");
const fs = require("fs");
const c = require("./config");

const {
  WA_TOKEN, PHONE_ID, VERIFY_TOKEN, GROQ_API_KEY, OWNER_NUMBER, PORT = 3000,
} = process.env;

const app = express();
app.use(express.json());

// ---------- Stockage simple (fichier JSON) ----------
const DB = "data.json";
const load = () => {
  try { return JSON.parse(fs.readFileSync(DB, "utf8")); }
  catch { return { commandes: [], rdv: [] }; }
};
const save = (d) => fs.writeFileSync(DB, JSON.stringify(d, null, 2));

// ---------- WhatsApp ----------
async function send(to, text) {
  const r = await fetch(`https://graph.facebook.com/v20.0/${PHONE_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } }),
  });
  if (!r.ok) console.error("Erreur envoi WhatsApp:", await r.text());
}

// ---------- IA (Groq) ----------
const systemPrompt = () => `Tu es l'assistant WhatsApp de "${c.nom}".
Activité : ${c.activite}
Adresse : ${c.adresse} | Horaires : ${c.horaires} | Contact : ${c.contact}
Paiement : ${c.paiement} | Livraison : ${c.livraison}
Catalogue :
${c.catalogue.map((x) => "- " + x).join("\n")}
FAQ :
${c.faq.join("\n")}
Rendez-vous : ${c.rdv}

Règles :
- Réponds dans la langue du client (français par défaut), court, chaleureux, adapté à WhatsApp.
- Tu fais : réponses aux questions, prise de commande, prise de rendez-vous.
- Commande : récupère le pack ou service choisi, le besoin (type de site, délai souhaité) et la ville du client, puis récapitule et demande confirmation. Appelle creer_commande SEULEMENT après un "oui" clair. Pour un projet sur devis, ne donne aucun prix : collecte le besoin et transmets à l'équipe.
- Rendez-vous : récupère date, heure, motif, puis appelle prendre_rdv après confirmation.
- N'invente jamais un prix, un produit ou une info absente ci-dessus : dis que tu transmets à l'équipe.`;

const tools = [
  {
    type: "function",
    function: {
      name: "creer_commande",
      description: "Enregistre une commande confirmée par le client",
      parameters: {
        type: "object",
        properties: {
          articles: { type: "string", description: "Articles et quantités" },
          total: { type: "string", description: "Total en FCFA" },
          adresse: { type: "string", description: "Adresse ou ville de livraison" },
        },
        required: ["articles"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "prendre_rdv",
      description: "Enregistre un rendez-vous confirmé par le client",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string" },
          heure: { type: "string" },
          motif: { type: "string" },
        },
        required: ["date", "heure"],
      },
    },
  },
];

const history = new Map(); // mémoire courte par client

async function runTool(from, name, a) {
  const db = load();
  const base = { client: from, le: new Date().toISOString() };
  let alerte, retour;
  if (name === "creer_commande") {
    db.commandes.push({ ...base, ...a, statut: "nouvelle" });
    alerte = `🛒 Nouvelle commande de ${from}\n${a.articles}\nTotal: ${a.total || "?"}\nAdresse: ${a.adresse || "?"}`;
    retour = `✅ Commande enregistrée !\n${a.articles}${a.total ? "\nTotal : " + a.total : ""}\nNotre équipe vous contacte très vite pour la suite.`;
  } else if (name === "prendre_rdv") {
    db.rdv.push({ ...base, ...a, statut: "à confirmer" });
    alerte = `📅 Nouveau RDV de ${from}\n${a.date} à ${a.heure}\nMotif: ${a.motif || "?"}`;
    retour = `✅ Rendez-vous noté pour le ${a.date} à ${a.heure}. Nous vous confirmons rapidement.`;
  } else return "";
  save(db);
  if (OWNER_NUMBER) await send(OWNER_NUMBER, alerte); // alerte le patron
  return retour;
}

async function ai(from, text) {
  const h = history.get(from) || [];
  h.push({ role: "user", content: text });
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      temperature: 0.4,
      messages: [{ role: "system", content: systemPrompt() }, ...h.slice(-12)],
      tools,
    }),
  });
  if (!r.ok) throw new Error(await r.text());
  const msg = (await r.json()).choices[0].message;
  let reply = msg.content || "";
  for (const t of msg.tool_calls || []) {
    reply = await runTool(from, t.function.name, JSON.parse(t.function.arguments));
  }
  h.push({ role: "assistant", content: reply });
  history.set(from, h.slice(-20));
  return reply || "Je transmets votre demande à l'équipe.";
}

// ---------- Preuves de paiement (image / document) ----------
async function recu(m) {
  const media = m[m.type];
  const db = load();
  db.preuves = db.preuves || [];
  db.preuves.push({ client: m.from, type: m.type, media_id: media.id, le: new Date().toISOString() });
  save(db);
  await send(m.from, "✅ Bien reçu ! Notre équipe vérifie votre paiement et revient vers vous très vite.");
  if (!OWNER_NUMBER) return;
  await send(OWNER_NUMBER, `💰 Preuve de paiement reçue de ${m.from}${media.caption ? " : " + media.caption : ""}`);
  const r = await fetch(`https://graph.facebook.com/v20.0/${PHONE_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to: OWNER_NUMBER, type: m.type, [m.type]: { id: media.id } }),
  });
  if (!r.ok) console.error("Erreur transfert preuve:", await r.text());
}

// ---------- Webhook ----------
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY_TOKEN)
    return res.status(200).send(req.query["hub.challenge"]);
  res.sendStatus(403);
});

app.post("/webhook", (req, res) => {
  res.sendStatus(200); // répondre vite à Meta
  const m = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!m) return;
  (async () => {
    try {
      if (m.type === "image" || m.type === "document") return await recu(m);
      if (m.type !== "text") return send(m.from, "Envoyez-moi votre demande par message texte 🙏");
      await send(m.from, await ai(m.from, m.text.body));
    } catch (e) {
      console.error(e);
      await send(m.from, "Petit souci technique, réessayez dans un instant 🙏");
    }
  })();
});

// Voir les données : /admin?key=VERIFY_TOKEN
app.get("/admin", (req, res) =>
  req.query.key === VERIFY_TOKEN ? res.json(load()) : res.sendStatus(403));

app.get("/", (_, res) => res.send(`${c.nom} bot en ligne ✅`));
app.listen(PORT, () => console.log("Bot lancé sur le port " + PORT));
