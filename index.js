require("dotenv").config();
const express = require("express");
const Imap = require("imap");
const { simpleParser } = require("mailparser");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

const RESULT_PATH = path.join(__dirname, "result.json");
const PROCESSED_PATH = path.join(__dirname, "processed.json");
const SUBJECT_FILTER = "Happy EV Taxi Phuket";

// === helper functions === (ใช้โค้ดของคุณได้เลย)
async function fetchAndProcessEmails() {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: process.env.EMAIL_USER,
      password: process.env.EMAIL_PASS,
      host: "imap.gmail.com",
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
    });

    let processed = [];
    if (fs.existsSync(PROCESSED_PATH)) {
      try {
        processed = JSON.parse(fs.readFileSync(PROCESSED_PATH));
      } catch {
        processed = [];
      }
    }

    const parseAndSend = async (bodyText, uid) => {
      // ... ใช้ parseEmailToJSON() จากโค้ดคุณ
      // แล้วส่งไปยัง API ด้วย axios.post(...)
    };

    imap.once("ready", () => {
      imap.openBox("INBOX", false, (err, box) => {
        if (err) return reject(err);

        imap.search(["UNSEEN"], (err, results) => {
          if (err || !results || results.length === 0) {
            console.log("📭 No new mail.");
            imap.end();
            return resolve("No new mail");
          }

          const latest = results.slice(-5);
          const fetch = imap.fetch(latest, { bodies: "", markSeen: true });

          fetch.on("message", (msg) => {
            let uid;
            msg.on("attributes", (attrs) => {
              uid = attrs.uid;
            });
            msg.on("body", (stream) => {
              simpleParser(stream, async (err, parsed) => {
                if (!parsed || !parsed.subject) return;

                const subject = parsed.subject.toLowerCase();
                if (!subject.includes(SUBJECT_FILTER.toLowerCase())) return;
                if (processed.includes(uid)) return;

                await parseAndSend(parsed.text || "", uid);
                processed.push(uid);
              });
            });
          });

          fetch.once("end", () => {
            fs.writeFileSync(
              PROCESSED_PATH,
              JSON.stringify(processed, null, 2)
            );
            imap.end();
            resolve("Processed new mail");
          });
        });
      });
    });

    imap.once("error", (err) => {
      console.error("❌ IMAP error:", err);
      reject(err);
    });

    imap.connect();
  });
}

// === ROUTE ===
app.get("/run-fetch-email", async (req, res) => {
  try {
    const result = await fetchAndProcessEmails();
    res.send(`✅ Done: ${result}`);
  } catch (e) {
    console.error("❌ Error:", e.message);
    res.status(500).send("❌ Error fetching email");
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
