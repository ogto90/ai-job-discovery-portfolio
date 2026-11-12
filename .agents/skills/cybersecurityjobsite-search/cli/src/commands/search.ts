import { disabledMessage, writeError } from "../helpers.js"

export async function runSearch(): Promise<number> {
  writeError(disabledMessage())
  return 1
}
