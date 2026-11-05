// @ts-nocheck
// ====================================================================================================
// Tempo · fonction « tempo-push » : envoie les messages du coach (notifications) toutes les minutes.
// À coller dans Supabase → Edge Functions → tempo-push (voir le guide). Aucune dépendance.
// Secrets à créer : TEMPO_PUSH_SECRET (obligatoire). Facultatifs : COACH_NAME (par défaut « Faissal »), TEMPO_SERVICE_KEY.
// ====================================================================================================

// ---------------------------------- Web Push (chiffrement + signature) ----------------------------------
// Web Push « fait maison » avec uniquement WebCrypto (identique dans Deno / Edge Functions et dans Node) :
//  - chiffrement du message : RFC 8291 (aes128gcm)
//  - identification de l'expéditeur : VAPID, RFC 8292 (JWT ES256)
const enc = new TextEncoder();
const subtle = globalThis.crypto.subtle;

const b64uToBytes = (s) => { s = String(s).replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
const bytesToB64u = (b) => { let bin = ""; b = new Uint8Array(b); for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]); return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const concat = (...a) => { const n = a.reduce((x, y) => x + y.length, 0); const o = new Uint8Array(n); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };

async function hkdf(salt, ikm, info, bytes) {
  const key = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

// Paire de clés VAPID : { publicKey (65 octets, base64url), privateJwk }
async function generateVapidKeys() {
  const kp = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await subtle.exportKey("jwk", kp.privateKey);
  const raw = new Uint8Array(await subtle.exportKey("raw", kp.publicKey));
  return { publicKey: bytesToB64u(raw), privateJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d } };
}

// En-tête Authorization VAPID pour un service de push donné (audience = origine de l'adresse d'envoi)
async function vapidAuthorization(endpoint, vapid, subject, nowSec = Math.floor(Date.now() / 1000)) {
  const aud = new URL(endpoint).origin;
  const head = bytesToB64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = bytesToB64u(enc.encode(JSON.stringify({ aud, exp: nowSec + 12 * 3600, sub: subject })));
  const key = await subtle.importKey("jwk", vapid.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(head + "." + body))); // 64 octets r||s : le format attendu par JWT ES256
  return "vapid t=" + head + "." + body + "." + bytesToB64u(sig) + ", k=" + vapid.publicKey;
}

// Chiffre un message pour un abonnement { p256dh, auth } (RFC 8291). opts.asKeyPair / opts.salt : uniquement pour les tests.
async function encryptPayload(sub, payload, opts = {}) {
  const uaPub = b64uToBytes(sub.p256dh), authSecret = b64uToBytes(sub.auth);
  if (uaPub.length !== 65 || uaPub[0] !== 4) throw new Error("clé p256dh invalide");
  if (authSecret.length !== 16) throw new Error("secret auth invalide");
  const uaKey = await subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const asPair = opts.asKeyPair || await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await subtle.exportKey("raw", asPair.publicKey));
  const ecdh = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: uaKey }, asPair.privateKey, 256));
  const ikm = await hkdf(authSecret, ecdh, concat(enc.encode("WebPush: info\0"), uaPub, asPub), 32);
  const salt = opts.salt || globalThis.crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const data = typeof payload === "string" ? enc.encode(payload) : payload;
  if (data.length > 3800) throw new Error("message trop long (3800 octets max)");
  const aes = await subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concat(data, new Uint8Array([2])))); // 0x02 = dernier bloc
  const rs = new Uint8Array([0, 0, 0x10, 0]); // taille de bloc 4096
  return concat(salt, rs, new Uint8Array([asPub.length]), asPub, cipher);
}

// Envoie un message ; renvoie { ok, status, gone, text }
async function sendWebPush(sub, payload, { vapid, subject, ttl = 3600, urgency = "normal", topic, fetchFn = fetch } = {}) {
  const body = await encryptPayload(sub, payload);
  const headers = { "Authorization": await vapidAuthorization(sub.endpoint, vapid, subject), "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", "TTL": String(ttl), "Urgency": urgency };
  if (topic) headers["Topic"] = topic;
  const res = await fetchFn(sub.endpoint, { method: "POST", headers, body });
  let text = ""; try { text = (await res.text()).slice(0, 300); } catch (e) {}
  return { ok: res.status >= 200 && res.status < 300, status: res.status, gone: res.status === 404 || res.status === 410, text };
}

// ---------------------------------- Le coach (planning et messages) ----------------------------------
// Cerveau du coach : planning (heure de Paris), messages variés, personnalisation, file d'attente.
// Tout est indépendant de la base : la couche de stockage (db) et l'envoi (send) sont injectés → testable hors ligne.
const COACH_NAME_DEFAULT = "Faissal";
const SITE_URL = "https://1fogeek-ui.github.io/FITAPP/";
const GRACE_MIN = 8;                // un message reste « dû » 8 minutes après son heure (au cas où un passage du minuteur serait manqué)
const DAY_MS = 86400000;

/* ------------------------------ messages ------------------------------ */
// Chaque message = une accroche (ma Puce, ton marrant) + un fond (même sens, tournures différentes).
const BANK = {
  breakfast: {
    g: ["Coucou ma Puce ☀️", "Debout ma Puce !", "Bonjour ma Puce 😘", "Réveil en douceur, ma Puce ☕", "Hello ma Puce !", "Bien dormi ma Puce ?", "Top départ, ma Puce !", "Alerte petit-déj, ma Puce 🚨", "Salut championne !", "Bon matin ma Puce 💛"],
    c: ["Tes omelettes t’attendent 🍳 Les fessiers ne se construisent pas avec de l’air !",
        "C’est l’heure des omelettes 🍳 Des protéines dès le matin, et tes cuisses seront de bonne humeur.",
        "Omelettes, 9h pile 🍳 Interdit de les remplacer par un croissant, je surveille 👀",
        "Petit-déj protéiné : omelettes ! 🍳 Ton futur toi (et tes fessiers) te disent merci.",
        "Direction la poêle : omelettes ! 🍳 Chef cuisinière, c’est à toi de jouer.",
        "N’oublie pas tes omelettes 🍳 Un muscle bien nourri est un muscle heureux.",
        "Les omelettes ne vont pas se faire toutes seules 🍳 (j’ai essayé de leur parler, ça ne marche pas)",
        "Mission du matin : omelettes 🍳 Mission accomplie = journée qui démarre en puissance.",
        "Petit-déj : omelettes ! 🍳 Les œufs, c’est la bonne dose de protéines pour des cuisses en acier 💪",
        "Ton ventre réclame des omelettes 🍳 Et tes muscles aussi, ils me l’ont dit.",
        "Prends tes omelettes en reine 👑 Assise, tranquille, sans courir partout.",
        "Omelettes, c’est maintenant 🍳 Ensuite tu pourras conquérir le monde (ou juste la presse à cuisses).",
        "Un petit-déj de championne : omelettes ! 🍳 Promis, je ne dirai rien si tu rajoutes du fromage 🧀",
        "Omelettes o’clock 🍳 Il est 9h, c’est écrit dans les étoiles (et dans mon téléphone).",
        "Ces œufs n’ont pas vocation à rester au frigo 🍳 Omelettes, on y va !",
        "Avant le téléphone, avant les mails : omelettes ! 🍳 Après, tu as le droit à tout 😉"] },
  snack: {
    g: ["Petit creux, ma Puce ? 🥄", "Ding dong, c’est l’heure du goûter, ma Puce 🔔", "Pause gourmande, ma Puce 😋", "Coucou ma Puce, c’est l’heure de ta collation !", "Alerte ventre qui gargouille, ma Puce 🚨", "Hello ma Puce 👋", "Recharge des batteries, ma Puce 🔋", "Ma Puce, pause protéines ! 💪"],
    c: ["Fromage blanc (avec un fruit ou deux 🍓) ou un petit repas protéiné : tes muscles adorent ça.",
        "Un bon fromage blanc, ou une collation protéinée : voilà de quoi construire de beaux fessiers 🍑",
        "Fromage blanc ou repas protéiné, au choix : le choix du champion, c’est de prendre les deux 😄",
        "Mange protéiné maintenant, tu me remercieras ce soir (et tes cuisses aussi).",
        "Fromage blanc, petit plat protéiné… peu importe, mais pas de biscuit solitaire, d’accord ? 😏",
        "Sors le fromage blanc 🥣 Tes cuisses n’attendent que ça pour récupérer.",
        "Une collation protéinée, et ça repart jusqu’au dîner 💪",
        "Fromage blanc ou repas protéiné : l’énergie de l’après-midi se prépare maintenant.",
        "Petite collation protéinée, grand effet sur tes muscles. C’est la science (et moi) qui le disent.",
        "Prends ta collation protéinée, et un sourire en plus 😊",
        "Fromage blanc ou repas protéiné, mais prends un vrai moment pour toi. Tu le mérites.",
        "C’est l’heure du fromage blanc 🥣 Ça a l’air tout simple, et pourtant ça change tout pour tes muscles."] },
  choco: {
    g: ["Chut, ma Puce, c’est le chocolat qui parle 🍫", "Alerte chocolat, ma Puce 🚨🍫", "Ce soir, ma Puce…", "Coucou ma Puce 🌙", "Douce soirée, ma Puce 🌙", "Ma Puce, moment de vérité 🍫", "Petit message de ton coach préféré 😏"],
    c: ["Tu peux te faire plaisir avec du chocolat, mais un petit morceau, pas la tablette entière 😂",
        "Le chocolat du soir est autorisé ✅ Avec modération, sinon contrôle surprise sur la tablette 🕵️",
        "Savoure ton chocolat, vraiment : lentement, avec plaisir, et en s’arrêtant à temps 😉",
        "Oui au plaisir, non à la tablette entière ! Quelques carreaux et c’est parfait 🍫",
        "Le chocolat est ton ami, mais comme tous les amis, il faut parfois savoir lui dire « à demain » 😄",
        "Un petit carré (ou deux) bien savouré : la qualité avant la quantité 👌",
        "Je ne dis pas non au chocolat, je dis « modération » 😇 Tes fessiers et moi t’en serons reconnaissants.",
        "Fais-toi plaisir ce soir, mais gentiment avec la tablette… elle est fragile 😅",
        "Chocolat : oui. Marathon de chocolat : non. Je te fais confiance 💛",
        "Un peu de chocolat pour la douceur, et on garde le reste pour demain, promis ?"] },
  train: {
    g: ["Allez ma Puce, c’est l’heure ! 💪", "Ma Puce, rendez-vous à la salle (ou au salon) !", "Debout les cuisses ! 🍑", "Alerte séance, ma Puce 🚨", "Coucou ma Puce, ton coach te parle 🎤", "Hop hop hop, ma Puce !", "Ma Puce, mets tes baskets ! 👟"],
    c: ["Séance cuisses & fessiers ce soir : ils t’attendent avec impatience 🍑",
        "Ouvre Tempo et lance ta séance : tes cuisses ont des choses à te dire 😄",
        "Aujourd’hui : cuisses & fessiers ! Même 30 minutes comptent, le plus dur c’est de commencer.",
        "Presse à cuisses, hip thrust, fentes… le menu du soir est servi 🍽️💪",
        "Pas de flemme ce soir : les fessiers ne se muscleront pas devant la télé 📺😂",
        "Petite séance, grand résultat : cuisses & fessiers, on s’y met ?",
        "Un échauffement, et c’est parti pour une belle séance de jambes. Je suis fier de toi d’avance 💛",
        "Ton futur toi te regarde et te dit « merci d’y aller » 🙏 Cuisses & fessiers au programme !",
        "5 minutes d’échauffement suffisent pour te lancer : après, tu ne voudras plus t’arrêter 🔥",
        "Cuisses & fessiers : ils ne vont pas se muscler tout seuls (j’ai déjà essayé de leur parler) 😂",
        "Hip thrust, glute bridge, squat… choisis ton arme 🗡️",
        "Ouvre Tempo, lance le chrono, et montre à ces cuisses qui commande 👑"] },
  train_late: {
    g: ["Ma Puce, dernier appel 📣", "Psst, ma Puce…", "Ding ! Dernier rappel, ma Puce 🔔", "Ma Puce, il est encore temps !"],
    c: ["Ta séance t’attend toujours : même 20 minutes de cuisses & fessiers, ça compte 💪",
        "Un échauffement, deux exercices, et c’est gagné 🏆",
        "Ton canapé est confortable, je sais, mais tes fessiers sont plus rancuniers 😅",
        "20 minutes, pas plus : presse à cuisses + hip thrust, et la soirée est à toi ✨",
        "Promis, tu te sentiras tellement mieux après ! Et moi, je serai fier de toi 💛"] },
  motiv: {
    g: ["Petit mot de ton coach, ma Puce 💌", "Coucou ma Puce, pensée du midi 🌞", "Ma Puce, tu gères !", "Message de motivation, ma Puce 📣"],
    c: ["Chaque séance te rapproche de ton objectif. Je suis fier de toi !",
        "Les fessiers ne se construisent pas en un jour, mais chaque séance compte 🍑",
        "Tu n’as pas à être parfaite, juste régulière. C’est comme ça qu’on progresse 💪",
        "Un peu de flemme ? C’est humain. Commence juste par l’échauffement, le reste suivra 🔥",
        "Ta version de demain te remercie de t’entraîner aujourd’hui 🙌",
        "Tu fais déjà mieux qu’hier ! Cuisses & fessiers : on garde le rythme.",
        "Bois de l’eau, étire-toi, et pense à ta prochaine séance 😉",
        "Tu progresses, même quand tu ne le vois pas encore. Fais confiance au processus 🌱",
        "Ta détermination me donne envie de m’y mettre aussi 😅",
        "Si tu doutes, rappelle-toi pourquoi tu as commencé. Et que je te trouve magnifique de toute façon 💛"] },
  comeback: {
    g: ["Ma Puce…", "Houston, ici ton coach 🚀", "Ma Puce, un petit mot sans reproche 💌", "Alerte fessiers en grève 🪧"],
    c: ["Tes cuisses m’ont écrit pour se plaindre : « on s’ennuie » 😅 Ça fait {n} jours, on s’y remet doucement ?",
        "Ça fait {n} jours sans séance ! Pas de panique, 20 minutes suffisent pour tout remettre en route 💪",
        "{n} jours sans entraînement. Je répète : {n} jours. Un petit squat pour me rassurer ? 😄",
        "Pas de reproche, juste de l’amour : {n} jours depuis ta dernière séance. Reprends en douceur, je suis avec toi 💛",
        "Négociations ouvertes avec tes fessiers : ils réclament une séance de hip thrust après {n} jours 🍑"] },
  sunday_ok: {
    g: ["Semaine validée, ma Puce ✅", "Dimanche soir, bilan : bravo ! 🏆", "Ma Puce, tu as tenu ta semaine 🎉"],
    c: ["{done}/{goal} séances cette semaine : je suis très fier de toi. On remet ça lundi ?",
        "{done}/{goal} séances ! Tes cuisses et tes fessiers te font une standing ovation 👏",
        "Objectif atteint ({done}/{goal}) ! Repose-toi bien, la semaine prochaine on garde le rythme 💪"] },
  sunday_miss: {
    g: ["Dimanche soir, ma Puce 📅", "Nouvelle semaine en vue, ma Puce !", "Petit bilan, ma Puce 📊"],
    c: ["{done}/{goal} séances cette semaine. Pas grave : on repart de zéro, choisis tes créneaux et on y va 💪",
        "{done}/{goal} cette semaine, la prochaine sera meilleure ! Bloque tes séances dans ton agenda 📅",
        "Cette semaine : {done}/{goal}. Demain, on prend un bon départ : cuisses & fessiers au programme 🍑"] },
  finish: {
    g: ["Bravo ma Puce ! 👏", "Séance terminée, ma Puce !", "Tu l’as fait ! 🎉", "Chapeau ma Puce 🎩", "Quelle séance ! 🔥", "Mission accomplie, ma Puce ✅", "Ding ding ding, victoire ! 🏆", "Je suis tellement fier de toi, ma Puce 💛"],
    c: ["{sets_txt} en {min_txt} : tes cuisses et tes fessiers vont m’écrire pour te remercier 😄",
        "{sets_txt} dans la poche ! Ce soir, tu as droit à un canapé bien mérité 🛋️",
        "{min_txt} d’effort, {sets_txt} : tu as fait plus que ceux qui y pensaient seulement 😎",
        "Tes muscles travaillent déjà pour toi pendant que tu te reposes. Beau boulot ! ({sets_txt})",
        "{sets_txt} terminées : la flemme a perdu, tu as gagné 🏅",
        "{min_txt} de séance ({sets_txt}) : tes fessiers te saluent bien bas 🍑🙇",
        "Tu avais dit « peut-être demain », tu as dit oui aujourd’hui. J’adore ça ! ({sets_txt})",
        "{sets_txt}, zéro excuse, 100 % championne 💪"],
    rec: ["Et en plus : record sur {rec} ★ Je suis scotché !", "Cerise sur le gâteau : nouveau record sur {rec} ★ 🎂", "Record battu sur {rec} ★ Tu es une machine !"],
    goal_ok: ["Objectif de la semaine atteint ({done}/{goal}) ✅ Tu gères !", "{done}/{goal} cette semaine : objectif validé ✅"],
    goal_more: ["{done}/{goal} cette semaine, on continue !", "Plus que {left} pour l’objectif de la semaine ({done}/{goal}) 💪"] },
  test: { g: ["Test réussi, ma Puce 🎉"], c: ["Si tu lis ce message, les notifications fonctionnent. À partir de maintenant, ton coach te parle tous les jours 😘"] },
};

/* ------------------------------ outils ------------------------------ */
const fill = (t, ctx) => t.replace(/\{(\w+)\}/g, (m, k) => (ctx[k] !== undefined ? String(ctx[k]) : m));
const plural = (n, w) => n + " " + w + (n > 1 ? "s" : "");
// choisit un indice qui n'a pas été utilisé récemment
function pickIndex(len, recent, rng) {
  const avoid = new Set(recent.slice(0, Math.max(0, Math.min(len - 1, 12))).map(Number));
  const ok = []; for (let i = 0; i < len; i++) if (!avoid.has(i)) ok.push(i);
  return ok[Math.floor(rng() * ok.length)];
}
// variantes déjà utilisées : "g:c" ou "g:c:r…" → liste des g récents et des c récents
function recentOf(recentVariants, pos) { return recentVariants.map((v) => String(v).split(":")[pos]).filter((x) => x !== undefined && x !== "" && x !== "-"); }
function composeMessage(kind, ctx, recentVariants = [], rng = Math.random) {
  const B = BANK[kind]; if (!B) throw new Error("type de message inconnu : " + kind);
  const gi = pickIndex(B.g.length, recentOf(recentVariants, 0), rng), ci = pickIndex(B.c.length, recentOf(recentVariants, 1), rng);
  let text = B.g[gi] + " " + B.c[ci], variant = gi + ":" + ci;
  if (kind === "finish") {
    const recs = ctx.recs || [];
    if (recs.length) { const ri = pickIndex(B.rec.length, recentOf(recentVariants, 2), rng); text += " " + B.rec[ri]; variant += ":" + ri; ctx = { ...ctx, rec: recs.join(" et ") }; }
    else variant += ":-";
    const done = ctx.done || 0, goal = ctx.goal || 3;
    if (!recs.length || text.length < 150) {
      if (done >= goal) text += " " + B.goal_ok[Math.floor(rng() * B.goal_ok.length)];
      else if (done > 0) text += " " + B.goal_more[Math.floor(rng() * B.goal_more.length)];
    }
    ctx = { ...ctx, sets_txt: plural(ctx.sets || 0, "série"), min_txt: (ctx.minutes || 0) + " min", left: Math.max(0, goal - done) };
  }
  return { text: fill(text, ctx), variant };
}

// Heure de Paris (heure d'été / d'hiver gérée) : { day: "2026-11-05", min: minutes depuis minuit, wd: 1 (lundi) … 7 (dimanche) }
const FMT = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" });
function parisParts(ms) {
  const p = {}; for (const x of FMT.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { day: p.year + "-" + p.month + "-" + p.day, min: Number(p.hour) * 60 + Number(p.minute), wd: { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[p.weekday] };
}
const dayNumber = (day) => Math.floor(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) / DAY_MS);
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const hm = (s, d) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(s || "")); return m ? Number(m[1]) * 60 + Number(m[2]) : d; };

// Ce que le coach sait de la personne, d'après son historique de séances
function profileFacts(history, goal, nowMs) {
  const today = parisParts(nowMs); const days = new Set(); let last = -Infinity;
  const weekStart = dayNumber(today.day) - (today.wd - 1); let done = 0;
  for (const ts of history || []) { if (typeof ts !== "number") continue; const d = parisParts(ts).day; days.add(d); const n = dayNumber(d); if (n > last) last = n; if (n >= weekStart && n <= weekStart + 6) done++; }
  return { trainedToday: days.has(today.day), daysSince: last === -Infinity ? null : dayNumber(today.day) - last, done, goal: Number.isInteger(goal) && goal >= 1 && goal <= 7 ? goal : 3 };
}

// Messages dus à l'instant `nowMs` pour un abonné (liste de { kind, at, ctx })
function dueForOwner(sub, facts, nowMs, recentComeback = false) {
  const t = parisParts(nowMs); const trainDays = Array.isArray(sub.train_days) && sub.train_days.length ? sub.train_days : [1, 3, 5];
  const isTrain = trainDays.includes(t.wd); const slots = [];
  slots.push({ kind: "breakfast", at: 9 * 60 });
  slots.push({ kind: "snack", at: 15 * 60 + 30 + (hashStr(t.day + sub.owner_key) % 76) }); // une heure « au hasard » entre 15h30 et 16h45
  slots.push({ kind: "choco", at: 20 * 60 + 30 });
  if (isTrain && !facts.trainedToday) { slots.push({ kind: "train", at: hm(sub.train_time, 17 * 60 + 30) }); slots.push({ kind: "train_late", at: 19 * 60 + 30 }); }
  if (!isTrain && t.wd !== 7) { slots.push({ kind: "motiv", at: 12 * 60 + 30 }); if (facts.daysSince !== null && facts.daysSince >= 4 && !facts.trainedToday && !recentComeback) slots.push({ kind: "comeback", at: 18 * 60, ctx: { n: facts.daysSince } }); }
  if (t.wd === 7) slots.push({ kind: facts.done >= facts.goal ? "sunday_ok" : "sunday_miss", at: 19 * 60, ctx: { done: facts.done, goal: facts.goal } });
  return slots.filter((s) => t.min >= s.at && t.min < s.at + GRACE_MIN).map((s) => ({ ...s, day: t.day }));
}

// Un exemple de chaque type de message (pour tester sur UN appareil sans attendre l'heure prévue)
const SAMPLE_KINDS = ["breakfast", "snack", "choco", "train", "train_late", "motiv", "comeback", "sunday_ok", "sunday_miss", "finish"];
const SAMPLE_CTX = { comeback: { n: 5 }, sunday_ok: { done: 3, goal: 3 }, sunday_miss: { done: 1, goal: 3 }, finish: { sets: 12, minutes: 48, recs: ["Hip thrust barre"], done: 2, goal: 3 } };
function sampleMessage(kind, rng = Math.random) {
  if (!BANK[kind] || kind === "test") throw new Error("type inconnu : " + kind);
  return { kind, text: composeMessage(kind, SAMPLE_CTX[kind] || {}, [], rng).text };
}

/* ------------------------------ moteur ------------------------------ */
// Une « passe » (appelée chaque minute) : messages programmés + file d'attente (félicitations, test…).
async function runTick({ db, send, now = Date.now(), rng = Math.random, coachName = COACH_NAME_DEFAULT }) {
  const report = { sent: [], skipped: 0, removed: 0, errors: [] };
  const vapid = await ensureVapid(db);
  const subs = await db.listCoachSubs(); if (!subs.length) return report;
  const byOwner = new Map(); for (const s of subs) { if (!byOwner.has(s.owner_key)) byOwner.set(s.owner_key, []); byOwner.get(s.owner_key).push(s); }
  const facts = new Map();
  const factsOf = async (owner, sub) => { if (!facts.has(owner)) { const info = await db.getProfileInfo(owner, sub.label); facts.set(owner, profileFacts(info.history, info.goal, now)); } return facts.get(owner); };

  async function deliver(owner, kind, ctx, day, variantKey) {
    const list = byOwner.get(owner);
    const recent = await db.recentVariants(owner, kind, 12);
    const msg = composeMessage(kind === "test" ? "test" : kind, ctx, recent, rng);
    const payload = JSON.stringify({ title: coachName, body: msg.text, tag: "coach-" + kind, url: "./", icon: "icon-192.png", badge: "badge-96.png" });
    let anyOk = false, transient = false;
    for (const sub of list) {
      const r = await send(sub, payload, vapid, kind);
      if (r.ok) { anyOk = true; await db.markSub(sub.id, { ok: true }); }
      else if (r.gone) { await db.deleteSub(sub.id); report.removed++; }
      else { transient = transient || r.status === 0 || r.status === 429 || r.status >= 500; await db.markSub(sub.id, { ok: false, error: "HTTP " + r.status + " " + (r.text || "") }); report.errors.push({ owner, kind, status: r.status }); }
    }
    report.sent.push({ owner, kind, text: msg.text, variant: msg.variant, ok: anyOk, devices: list.length });
    return { anyOk, transient, variant: msg.variant };
  }

  const NEUTRAL = { trainedToday: false, daysSince: 99, done: 0, goal: 3 }; // sert à savoir si QUELQUE CHOSE peut être dû, sans lire la base
  for (const [owner, list] of byOwner) {
    const sub0 = { ...list[0], owner_key: owner };
    if (!dueForOwner(sub0, NEUTRAL, now, false).length) continue; // rien à l'horloge : aucune lecture de l'historique (économise la base)
    const f = await factsOf(owner, sub0);
    const recentComeback = (await db.recentVariants(owner, "comeback", 1, 2 * DAY_MS, now)).length > 0;
    for (const slot of dueForOwner(sub0, f, now, recentComeback)) {
      if (!(await db.claimLog(owner, slot.kind, slot.day, "…", now))) { report.skipped++; continue; } // déjà envoyé (ou en cours) aujourd'hui
      try {
        const r = await deliver(owner, slot.kind, slot.ctx || {}, slot.day);
        await db.setLogVariant(owner, slot.kind, slot.day, r.variant);
        if (!r.anyOk && r.transient) await db.deleteLog(owner, slot.kind, slot.day); // erreur passagère : on réessaiera à la passe suivante
      } catch (e) { await db.deleteLog(owner, slot.kind, slot.day); report.errors.push({ owner, kind: slot.kind, error: String(e && e.message || e) }); }
    }
  }
  // file d'attente (félicitations de fin de séance, test…)
  for (const row of await db.claimQueue(now)) {
    if (!byOwner.has(row.owner_key)) continue;
    const key = parisParts(now).day + "#q" + row.id;
    try { await db.claimLog(row.owner_key, row.kind, key, "…", now); const r = await deliver(row.owner_key, row.kind, row.payload || {}, key); await db.setLogVariant(row.owner_key, row.kind, key, r.variant); }
    catch (e) { report.errors.push({ queue: row.id, error: String(e && e.message || e) }); }
  }
  return report;
}

async function ensureVapid(db) {
  let v = await db.getConfig("vapid");
  if (!v) { v = await generateVapidKeys(); await db.setConfig("vapid", v); }
  return v;
}

// ============================ Couche Supabase (base de données + point d'entrée HTTP) ============================
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
function pickServiceKey() {
  const direct = Deno.env.get("TEMPO_SERVICE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (direct) return direct;
  try { const m = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"); const v = Object.values(m)[0]; if (typeof v === "string") return v; } catch (_) { /* ignoré */ }
  return "";
}
const SERVICE_KEY = pickServiceKey();
const SECRET = Deno.env.get("TEMPO_PUSH_SECRET") || "";
const COACH_NAME = Deno.env.get("COACH_NAME") || COACH_NAME_DEFAULT;

const iso = (ms) => new Date(ms).toISOString();
const q = (v) => encodeURIComponent(String(v));
function restHeaders(extra = {}) {
  const h = { apikey: SERVICE_KEY, "Content-Type": "application/json", ...extra };
  if (!SERVICE_KEY.startsWith("sb_")) h.Authorization = "Bearer " + SERVICE_KEY; // les nouvelles clés « sb_secret_… » ne se passent pas en Bearer
  return h;
}
async function pg(path, init = {}) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/" + path, { ...init, headers: restHeaders(init.headers || {}) });
  const text = await res.text();
  if (!res.ok) throw new Error(path.split("?")[0] + " : HTTP " + res.status + " " + text.slice(0, 200));
  return text ? JSON.parse(text) : null;
}
const norm = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

function makeDb() {
  const failCounts = new Map();
  return {
    async getConfig(name) { const r = await pg("tempo_push_config?name=eq." + q(name) + "&select=value"); return r && r[0] ? r[0].value : null; },
    async setConfig(name, value) { await pg("tempo_push_config", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify({ name, value, updated_at: iso(Date.now()) }) }); },
    async listCoachSubs() {
      const rows = await pg("tempo_push_subs?coach=eq.true&select=id,owner_key,label,endpoint,p256dh,auth,train_days,train_time,fail_count") || [];
      rows.forEach((r) => failCounts.set(r.id, r.fail_count || 0)); return rows;
    },
    async getProfileInfo(owner, label) {
      const rows = await pg("tempo_profiles?owner_key=eq." + q(owner) + "&select=name,history:data->history,goal:data->goal&order=id") || [];
      if (!rows.length) return { history: [], goal: 3 };
      const row = rows.find((r) => norm(r.name) === norm(label)) || rows[0];
      const history = (Array.isArray(row.history) ? row.history : []).map((x) => (x && typeof x.date === "number" ? x.date : null)).filter((x) => x !== null);
      return { history, goal: row.goal };
    },
    async claimLog(owner, kind, day, variant, now) {
      const r = await pg("tempo_push_log", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=representation" }, body: JSON.stringify({ owner_key: owner, kind, day, variant, sent_at: iso(now) }) });
      return Array.isArray(r) && r.length > 0; // vide = déjà présent (déjà envoyé, ou en cours d'envoi par une autre passe)
    },
    async setLogVariant(owner, kind, day, variant) { await pg("tempo_push_log?owner_key=eq." + q(owner) + "&kind=eq." + q(kind) + "&day=eq." + q(day), { method: "PATCH", body: JSON.stringify({ variant }) }); },
    async deleteLog(owner, kind, day) { await pg("tempo_push_log?owner_key=eq." + q(owner) + "&kind=eq." + q(kind) + "&day=eq." + q(day), { method: "DELETE" }); },
    async recentVariants(owner, kind, limit, sinceMs = null, now = Date.now()) {
      let path = "tempo_push_log?owner_key=eq." + q(owner) + "&kind=eq." + q(kind) + "&variant=neq." + q("…") + "&select=variant&order=sent_at.desc&limit=" + limit;
      if (sinceMs !== null) path += "&sent_at=gte." + q(iso(now - sinceMs));
      return ((await pg(path)) || []).map((r) => r.variant);
    },
    async deleteSub(id) { await pg("tempo_push_subs?id=eq." + q(id), { method: "DELETE" }); },
    async markSub(id, r) {
      const body = r.ok ? { fail_count: 0, last_error: null, last_ok_at: iso(Date.now()) } : { fail_count: (failCounts.get(id) || 0) + 1, last_error: String(r.error || "").slice(0, 300) };
      await pg("tempo_push_subs?id=eq." + q(id), { method: "PATCH", body: JSON.stringify(body) });
    },
    async claimQueue(now) { // « prend » les messages dus en une seule requête : une même ligne ne peut pas être envoyée deux fois
      return (await pg("tempo_push_queue?sent_at=is.null&due_at=lte." + q(iso(now)), { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ sent_at: iso(now) }) })) || [];
    },
    async enqueue(owner, kind, payload, dueMs) { await pg("tempo_push_queue", { method: "POST", body: JSON.stringify({ owner_key: owner, kind, payload, due_at: iso(dueMs) }) }); },
  };
}

const TTL = { finish: 1800, test: 600 };
// explication en clair du refus éventuel du service de notification (Apple, Google, Mozilla)
const hint = (st) => st === 404 || st === 410 ? "L'appareil n'est plus abonné : réactive les notifications dans la carte de l'appli, puis relis l'identifiant."
  : st === 400 || st === 401 || st === 403 ? "Le service (Apple ou Google) refuse l'identification de l'expéditeur : donne-moi la « reponse_du_service »."
  : st === 413 ? "Message trop long." : st === 429 ? "Trop d'envois : attends quelques minutes." : st >= 500 ? "Panne passagère du service de notification : réessaie dans un instant." : "Réponse inattendue du service.";
const send = (sub, payload, vapid, kind) => sendWebPush(sub, payload, { vapid, subject: SITE_URL, ttl: TTL[kind] || 7200, topic: String(kind).slice(0, 32) });
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
function sameSecret(a, b) { if (!a || !b || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }

async function handle(req) {
  if (!SECRET) return json({ ok: false, error: "TEMPO_PUSH_SECRET n'est pas défini dans les secrets de la fonction" }, 500);
  if (!sameSecret(req.headers.get("x-tempo-secret") || "", SECRET)) return json({ ok: false, error: "non autorisé" }, 401);
  if (!SUPABASE_URL || !SERVICE_KEY) return json({ ok: false, error: "clé de service introuvable : ajoutez le secret TEMPO_SERVICE_KEY (votre clé « secret » Supabase)" }, 500);
  let body = {}; try { body = await req.json(); } catch (_) { /* corps vide */ }
  const action = body.action || "tick"; const db = makeDb(); const now = Date.now();
  try {
    if (action === "test" && body.sub_id) { // test sur UN appareil précis (même sans « coach »), sans toucher aux autres abonnés
      const rows = await pg("tempo_push_subs?id=eq." + q(body.sub_id) + "&select=id,owner_key,label,endpoint,p256dh,auth");
      if (!rows || !rows[0]) return json({ ok: false, error: "appareil introuvable : vérifie l'identifiant (select id, label from public.tempo_push_subs)" }, 404);
      const kinds = body.sample === "all" ? SAMPLE_KINDS : [body.sample || "breakfast"];
      for (const k of kinds) if (!SAMPLE_KINDS.includes(k)) return json({ ok: false, error: "exemple inconnu : " + k + " (au choix : all, " + SAMPLE_KINDS.join(", ") + ")" }, 400);
      const vapid = await ensureVapid(db); const sent = [];
      for (const k of kinds) {
        const msg = sampleMessage(k);
        const r = await send(rows[0], JSON.stringify({ title: COACH_NAME, body: msg.text, tag: "coach-" + k, url: "./", icon: "icon-192.png", badge: "badge-96.png" }), vapid, "test");
        sent.push(r.ok ? { type: k, ok: true, statut: r.status } : { type: k, ok: false, statut: r.status, reponse_du_service: r.text, aide: hint(r.status) });
        await db.markSub(rows[0].id, r.ok ? { ok: true } : { ok: false, error: "HTTP " + r.status + " " + (r.text || "") });
        if (r.gone) { await db.deleteSub(rows[0].id); break; }
        if (kinds.length > 1) await new Promise((res) => setTimeout(res, 700)); // un petit intervalle pour qu'ils arrivent dans l'ordre
      }
      return json({ ok: true, action, appareil: rows[0].label, envoyes: sent });
    }
    if (action === "test") { // envoie tout de suite un message de test à tous les abonnés « coach »
      const owners = [...new Set((await db.listCoachSubs()).map((s) => s.owner_key))];
      for (const o of owners) await db.enqueue(o, "test", {}, now);
    }
    if (action === "status") {
      const subs = await pg("tempo_push_subs?select=label,coach,created_at,last_ok_at,last_error,train_days,train_time&order=created_at.desc") || [];
      const vapid = await db.getConfig("vapid");
      return json({ ok: true, vapid: !!vapid, abonnements: subs });
    }
    const report = await runTick({ db, send, now, coachName: COACH_NAME });
    return json({ ok: true, action, envoyes: report.sent.map((s) => ({ type: s.kind, appareils: s.devices, ok: s.ok })), supprimes: report.removed, erreurs: report.errors });
  } catch (e) { return json({ ok: false, error: String((e && e.message) || e) }, 500); }
}
if (typeof Deno !== "undefined" && Deno.serve) Deno.serve(handle);
