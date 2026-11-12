import { disabledMessage, writeError } from "../helpers.js"

export async function runDetail(): Promise<number> {
  writeError(disabledMessage())
  return 1
}
