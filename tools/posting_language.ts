// Conservative evidence check: short or mixed snippets remain unknown.
export function postingLanguage(value: unknown): "english" | "non_english" | "unknown" {
  const text = String(value ?? "").replace(/<[^>]*>/g, " ").toLowerCase()
  const words = text.match(/\p{L}+/gu) ?? []
  if (words.length < 30) return "unknown"
  if ((text.match(/[\u0400-\u04ff]/g)?.length ?? 0) > 50) return "non_english"
  const english = new Set("the and with your our you will have this for are we that experience team work role skills responsibilities candidate position".split(" "))
  const other = new Set("und wir sie der die das mit ein eine für du dein deine unser unsere auf den dem dich des sowie suchen erfahrung kenntnisse og med til dig vores erfaring søger och att som erfarenhet vi är et les des nous vous votre pour une dans avec poste expérience y los las para con nuestro nuestra experiencia en trabajo".split(" "))
  const en = words.filter((word) => english.has(word)).length
  const non = words.filter((word) => other.has(word)).length
  if (non >= 10 && non > en * 2) return "non_english"
  return en >= 8 && en > non * 2 ? "english" : "unknown"
}
