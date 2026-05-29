import { existsSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";

for (const candidate of [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")]) {
  if (existsSync(candidate)) {
    dotenv.config({ path: candidate });
  }
}
