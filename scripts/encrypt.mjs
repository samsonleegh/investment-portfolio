// Encrypt data/portfolio.json -> data/portfolio.enc.json (the only data file you commit).
//
//   node scripts/encrypt.mjs            # prompts for the passphrase
//   node scripts/encrypt.mjs --decrypt  # enc -> plain, e.g. to inspect or re-export
//
// The passphrase can also come from the PORTFOLIO_PASSPHRASE env var.

import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { encryptJSON, decryptJSON } from "../assets/crypto.js";

const PLAIN = new URL("../data/portfolio.json", import.meta.url);
const ENC = new URL("../data/portfolio.enc.json", import.meta.url);
const decrypt = process.argv.includes("--decrypt");

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => rl.output.write(s.startsWith(question) ? s : "");
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

let pass = process.env.PORTFOLIO_PASSPHRASE;
if (!pass) {
  pass = await askHidden("Passphrase: ");
  if (!decrypt && (await askHidden("Repeat passphrase: ")) !== pass) {
    console.error("Passphrases don't match.");
    process.exit(1);
  }
}
if (!decrypt && pass.length < 8) {
  console.error("Use at least 8 characters — this file will sit in a public repo.");
  process.exit(1);
}

if (decrypt) {
  const data = await decryptJSON(JSON.parse(await readFile(ENC, "utf8")), pass);
  await writeFile(PLAIN, JSON.stringify(data, null, 1));
  console.log("Wrote data/portfolio.json");
} else {
  const data = JSON.parse(await readFile(PLAIN, "utf8"));
  await writeFile(ENC, JSON.stringify(await encryptJSON(data, pass)));
  console.log(`Wrote data/portfolio.enc.json (${data.months.length} months)`);
}
