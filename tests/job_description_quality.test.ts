import { describe, expect, test } from "bun:test"
import { classifyJobDescription, isUsableFullJobDescription } from "../tools/job_description_quality"

describe("job description completeness", () => {
  test("accepts a valid compact description even when its source marked it partial", () => {
    const compact = `
      <h2>Responsibilities</h2><p>Lead application security reviews, design practical controls, implement improvements,
      support product teams, assess vulnerabilities, and respond to incidents across customer-facing services.</p>
      <h2>Qualifications</h2><p>Bring professional security experience, clear communication, and the ability to collaborate
      with engineering, product, and operations teams to deliver measurable risk reduction.</p>`
    expect(isUsableFullJobDescription(compact)).toBe(true)
    expect(classifyJobDescription(compact)).toBe("full")
  })

  test("does not promote a long teaser or navigation-heavy page to a full JD", () => {
    const teaser = "Join our team to help build innovative products and improve security across the company. ".repeat(8)
    const boilerplate = `<div>Responsibilities: Design controls, lead reviews, implement safeguards, support engineering teams.</div>
      <footer>${"Privacy policy. Terms of service. Cookie preferences. Browse all jobs. Sign in. All rights reserved. ".repeat(18)}</footer>`
    expect(classifyJobDescription(teaser)).toBe("snippet")
    expect(classifyJobDescription(boilerplate)).toBe("snippet")
  })

  test("does not treat hidden script payload as a job description", () => {
    expect(classifyJobDescription("<script>" + "security role responsibilities ".repeat(80) + "</script>")).toBe("missing")
  })

  test("keeps substantive single-line JD text when boilerplate appears in the same line", () => {
    const flattened = `Responsibilities: Lead application security reviews, design practical controls, implement improvements, support product teams, assess vulnerabilities, and respond to incidents across customer-facing services. Qualifications: Bring professional security experience, clear communication, and the ability to collaborate with engineering, product, and operations teams to deliver measurable risk reduction. Equal opportunity employer. Privacy policy.`
    expect(classifyJobDescription(flattened)).toBe("full")
  })
})
