require("dotenv").config(); // โหลด .env ไฟล์
const fs = require("fs");
const path = require("path");
const Imap = require("imap");
const { simpleParser } = require("mailparser");
const axios = require("axios");

const RESULT_PATH = path.join(__dirname, "result.json");
const PROCESSED_PATH = path.join(__dirname, "processed.json");

const SUBJECT_FILTER = "Happy EV Taxi Phuket";

let processed = [];
if (fs.existsSync(PROCESSED_PATH)) {
  try {
    processed = JSON.parse(fs.readFileSync(PROCESSED_PATH));
  } catch {
    processed = [];
  }
}

// const imap = new Imap({
//   user: "kaewphun5050@gmail.com", //process.env.EMAIL_USER,
//   password: "nrea hsgn acrd itqt", //process.env.EMAIL_PASS,
//   host: "imap.gmail.com",
//   port: 993,
//   tls: true,
//   tlsOptions: { rejectUnauthorized: false },
// });

const imap = new Imap({
  user: "info.happyev@gmail.com", //process.env.EMAIL_USER,
  password: "biic jthj hqah czzy", //process.env.EMAIL_PASS,
  host: "imap.gmail.com",
  port: 993,
  tls: true,
  tlsOptions: { rejectUnauthorized: false },
});

function openInbox(cb) {
  imap.openBox("INBOX", false, cb);
}

async function sendResultsToAPI(results) {
  console.log("results====>  ", results);

  try {
    // const apiURL =
    //   process.env.API_IMPORT_EMAIL_RESULTS ||
    //   `${process.env.BASE_URL}/import-email-results`;
    const apiURL =
      "https://api.happyevtravelandtransfer.com/import-email-results";

    // const apiURL = "https://6a6cff924b35.ngrok-free.app/import-email-results";
    console.log("apiURL====>  ", apiURL);

    const response = await axios.post(apiURL, { data: results });
    console.log("✅ ส่งข้อมูลไป API สำเร็จ:", response.data);
  } catch (error) {
    console.error("❌ ส่งข้อมูลไป API ไม่สำเร็จ:", error.message);
  }
}

async function parseEmailToJSON(bodyText) {
  if (!bodyText || bodyText.trim().length === 0) {
    console.log("⚠️ Email body is empty, skip parsing");
    return;
  }
  console.log("🔍 Parsing email body...");

  const blocks = bodyText
    .split("บริษัทแฮพเพนอินเมย์ จำกัด")
    .map((b) => b.split("ADVANCE BOOKING")[0]?.trim())
    .filter(Boolean);

  console.log(`🔎 Found ${blocks.length} blocks after splitting`);

  if (blocks.length === 0) {
    console.log("⚠️ ไม่พบข้อมูลตาม pattern ในอีเมล");
    return;
  }

  const extract = (text, regex) => {
    const match = text.match(regex);
    return match ? match[1].trim() : "";
  };

  const results = blocks.map((block) => {
    const Order = extract(block, /Order:\s*(.+)/);
    const Employee = extract(block, /Employee:\s*(.+)/);
    const POS = extract(block, /POS:\s*(.+)/);

    const LPR = extract(
      block,
      /แคชเชียร์\s*([\u0E00-\u0E7Fa-zA-Z0-9\s]+?)\s*฿0\.00/
    );

    const rawDestination = extract(block, /1 × ฿0\.00\s+(.+)/);

    let form = "";
    let to = "";

    if (rawDestination.includes("-")) {
      const [part1, ...rest] = rawDestination.split("-");
      form = part1.trim();
      to = rest.join("-").trim();
    }

    const totalMatches = [...block.matchAll(/Total\s+฿([0-9,.]+)/g)];
    const Total =
      totalMatches.length > 0
        ? `฿${totalMatches[totalMatches.length - 1][1]}`
        : "";

    return {
      Order,
      Employee,
      POS,
      LPR,
      destination: rawDestination,
      form,
      to,
      Total,
    };
  });

  const filteredResults = results.filter((obj) =>
    Object.values(obj).some((value) => value !== "")
  );

  if (filteredResults.length === 0) {
    console.log("ℹ️ ไม่มีข้อมูลที่ถูกดึงออกมาจากอีเมล");
    return;
  }

  let existing = [];
  if (fs.existsSync(RESULT_PATH)) {
    try {
      existing = JSON.parse(fs.readFileSync(RESULT_PATH, "utf8"));
    } catch {
      console.error("⚠️ อ่าน result.json ไม่สำเร็จ, เริ่มใหม่");
      existing = [];
    }
  }

  const existingOrders = new Set(existing.map((item) => item.Order));
  const uniqueResults = filteredResults.filter(
    (item) => item.Order && !existingOrders.has(item.Order)
  );

  if (uniqueResults.length === 0) {
    console.log("ℹ️ ไม่มีข้อมูลใหม่ที่ต้องบันทึก (Order ซ้ำหมด)");
    return;
  }

  // บันทึกลงไฟล์ (ถ้าต้องการเก็บสำรอง)
  const merged = [...existing, ...uniqueResults];
  fs.writeFileSync(RESULT_PATH, JSON.stringify(merged, null, 2), "utf8");
  console.log(
    `✅ บันทึกเพิ่ม ${uniqueResults.length} รายการใหม่ลง result.json`
  );

  // ส่งข้อมูลใหม่ไป API
  await sendResultsToAPI(uniqueResults);
}

imap.once("ready", () => {
  console.log("✅ Connected to Gmail via IMAP");
  openInbox((err, box) => {
    if (err) throw err;
    console.log("📬 Listening for new mail...");
  });

  imap.on("mail", () => {
    console.log("📥 Mail event received!");
    fetchLatestMail();
  });
});

imap.once("error", (err) => {
  console.error("❌ IMAP Error:", err);
});

imap.once("end", () => {
  console.log("📴 Connection ended. Attempting to reconnect...");
  setTimeout(() => {
    imap.connect();
  }, 5000);
});

function fetchLatestMail() {
  imap.search(["UNSEEN"], (err, results) => {
    if (err) {
      console.error("🔍 Search error:", err);
      return;
    }

    if (!results || results.length === 0) {
      console.log("📭 No new unread emails.");
      return;
    }

    const latest = results.slice(-1);
    const fetch = imap.fetch(latest, {
      bodies: "",
      markSeen: true,
    });

    fetch.on("message", (msg, seqno) => {
      let uid;
      msg.on("attributes", (attrs) => {
        uid = attrs.uid;
      });

      msg.on("body", (stream) => {
        simpleParser(stream, async (err, parsed) => {
          if (err) {
            console.error("❌ Parse error:", err);
            return;
          }

          if (!uid) {
            console.warn("⚠️ ไม่พบ uid ของเมลนี้, ข้ามเมลนี้");
            return;
          }

          // เช็ค Subject แบบไม่สนเคส
          const subjectLower = parsed.subject?.toLowerCase() || "";
          const filterLower = SUBJECT_FILTER.toLowerCase().trim();

          if (!subjectLower.includes(filterLower)) {
            console.log(
              `❌ ข้ามเมล uid:${uid} เพราะหัวข้อไม่ตรงกับ '${SUBJECT_FILTER}'`
            );
            return;
          }

          if (processed.includes(uid)) {
            console.log(`⏭️ ข้ามเมลที่เคยประมวลผลแล้ว (uid: ${uid})`);
            return;
          }

          console.log("\n🆕 New Email Received!");
          console.log("📌 Subject:", parsed.subject);
          console.log("👤 From:", parsed.from.text);
          console.log("📝 Text:", parsed.text?.trim().slice(0, 500));

          try {
            await parseEmailToJSON(parsed.text || "");
            processed.push(uid);
            fs.writeFileSync(
              PROCESSED_PATH,
              JSON.stringify(processed, null, 2)
            );
            console.log(`✅ บันทึก uid ${uid} ลง processed.json`);
          } catch (e) {
            console.error("❌ Error processing email body:", e);
          }
        });
      });
    });

    fetch.once("end", () => {
      console.log("✅ Done fetching email");
    });
  });
}

imap.connect();
