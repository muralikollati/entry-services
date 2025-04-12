const express = require("express");
const multer = require("multer");
const axios = require("axios");
const FormData = require("form-data");
const cors = require("cors");
const { GoogleGenAI } = require("@google/genai");
const { db } = require("./firebase");
const verifyAuth = require("../auth/verifyAuth");
const dotenv = require('dotenv');

const app = express();
app.use(cors());
app.use(express.json());
app.use(verifyAuth);
dotenv.config({ path: '../.env' });

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const upload = multer({ storage: multer.memoryStorage() });
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const normalizeDate = (date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0); // sets time to 00:00:00.000
  return d;
};


async function extractTeluguData(teluguInput) {
  const prompt = `
  Read the following Telugu sentence and:
  1. Extract the name, quantity (convert Telugu number words to digits), unit (convert Telugu unit words like కేజీలు, కేజీ to "kg"), and item (if any).
  2. Return only a valid JSON object with keys: name, quantity, unit, item.
  3. Do not include any explanation or extra text.
  
  Sentence: ${teluguInput}
  Output:
  `;
  const response = await ai.models.generateContent({
    model: "gemini-2.0-flash",
    contents: prompt,
  });
  console.log(response.text);
  return response.text;
}

app.post("/transcribe", upload.single("audio"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No audio file uploaded" });
  }

  try {
    const form = new FormData();
    form.append("file", req.file.buffer, {
      filename: req.file.originalname,
      contentType: req.file.mimetype,
    });
    form.append("model_id", "scribe_v1");
    form.append("language_code", "tel");
    form.append("diarize", "true");
    form.append("tag_audio_events", "true");

    const response = await axios.post(
      "https://api.elevenlabs.io/v1/speech-to-text",
      form,
      {
        headers: {
          ...form.getHeaders(),
          "xi-api-key": ELEVENLABS_API_KEY,
        },
      }
    );
    output = await extractTeluguData(response.data.text);
    console.log("output", output);
    res.json({ transcription: response.data.text, output });
  } catch (error) {
    console.error(
      "Transcription Error:",
      error.response?.data || error.message
    );
    res
      .status(500)
      .json({ error: "Transcription failed", details: error.message });
  }
});

// ✅ Create person scoped by user
app.post("/create-person", verifyAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const {
      name = "",
      selected_date = "",
      quantity_entries = [],
      item = "",
      unit = "",
    } = req.body;

    if (!name || !selected_date || !Array.isArray(quantity_entries) || quantity_entries.length === 0) {
      return res.status(400).json({ error: "Missing or invalid fields" });
    }

    const totalQuantity = quantity_entries.reduce((acc, val) => acc + val, 0);

    const personRef = await db.collection("persons").add({
      user_id: userId, // 👈 link to user
      name,
      total_quantity: totalQuantity,
      unit,
      item,
      created_at: new Date().toISOString(),
      modified_at: new Date().toISOString(),
    });

    await personRef.collection("details").add({
      selected_date: normalizeDate(selected_date),
      quantity_entries,
      item,
      unit,
      total_quantity: totalQuantity,
      created_date: selected_date,
      modified_date: selected_date,
    });

    res.json({ message: "Person and first daily entry added", person_id: personRef.id });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// ✅ Add entry with user ownership check
app.post("/person/:id/add-entry", verifyAuth, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.uid;
  const {
    name = "",
    selected_date = "",
    quantity_entries = [],
    item = "",
    unit = "",
  } = req.body;

  if (!name || !selected_date || !Array.isArray(quantity_entries) || quantity_entries.length === 0) {
    return res.status(400).json({ error: "Missing or invalid fields" });
  }

  try {
    const totalNew = quantity_entries.reduce((sum, val) => sum + val, 0);
    const personRef = db.collection("persons").doc(id);
    const personDoc = await personRef.get();

    if (!personDoc.exists || personDoc.data().user_id !== userId) {
      return res.status(404).json({ error: "Person not found or unauthorized" });
    }

    const oldTotal = personDoc.data().total_quantity || 0;
    await personRef.update({ total_quantity: oldTotal + totalNew });

    const detailRef = personRef.collection("details");
    const dateSnap = await detailRef.where("selected_date", "==", normalizeDate(selected_date)).get();

    if (!dateSnap.empty) {
      const existingDoc = dateSnap.docs[0];
      const oldEntries = existingDoc.data().quantity_entries || [];
      const updatedEntries = [...oldEntries, ...quantity_entries];
      await detailRef.doc(existingDoc.id).update({ quantity_entries: updatedEntries });
    } else {
      await detailRef.add({
        created_date: selected_date,
        modified_date: selected_date,
        selected_date: normalizeDate(selected_date),
        item,
        unit,
        quantity_entries,
      });
    }

    res.json({
      message: "Entry added/updated successfully",
      total_quantity: oldTotal + totalNew,
    });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// ✅ Get all persons belonging to authenticated user
app.get("/persons", verifyAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const snapshot = await db.collection("persons").where("user_id", "==", userId).get();
    const persons = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json(persons);
  } catch (err) {
    console.error("Error fetching persons:", err);
    res.status(500).json({ error: "Failed to fetch persons", details: err.message });
  }
});

// ✅ Paginated detail entries scoped by person & user
app.get("/person/:id/details", verifyAuth, async (req, res) => {
  const { id } = req.params;
  const { lastVisibleDate, pageSize = 10 } = req.query;
  const userId = req.user.uid;

  try {
    const personRef = db.collection("persons").doc(id);
    const personDoc = await personRef.get();
    if (!personDoc.exists || personDoc.data().user_id !== userId) {
      return res.status(404).json({ error: "Person not found or unauthorized" });
    }

    let ref = personRef.collection("details").orderBy("selected_date", "desc").limit(Number(pageSize));

    if (lastVisibleDate) {
      const lastSnap = await personRef.collection("details").doc(lastVisibleDate).get();
      if (lastSnap.exists) {
        ref = ref.startAfter(lastSnap);
      }
    }

    const snapshot = await ref.get();
    const details = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json(details);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// ✅ Search persons scoped to current user
app.get("/persons/search", verifyAuth, async (req, res) => {
  const { name } = req.query;
  const userId = req.user.uid;

  if (!name) return res.status(400).json({ error: "Missing name query parameter" });

  try {
    const snapshot = await db
      .collection("persons")
      .where("user_id", "==", userId)
      .where("name", ">=", name)
      .where("name", "<=", name + "\uf8ff")
      .get();

    const results = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json(results);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// ✅ Delete person only if user owns it
app.delete("/person-delete/:id", verifyAuth, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.uid;

  try {
    const personRef = db.collection("persons").doc(id);
    const personDoc = await personRef.get();

    if (!personDoc.exists || personDoc.data().user_id !== userId) {
      return res.status(404).json({ error: "Person not found or unauthorized" });
    }

    const detailsSnap = await personRef.collection("details").get();
    const batch = db.batch();
    detailsSnap.forEach((doc) => batch.delete(doc.ref));
    batch.delete(personRef);

    await batch.commit();
    res.json({ message: "Person and their details deleted successfully" });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.listen(5001, "0.0.0.0", () => {
  console.log("Server is running on port 5001");
});
