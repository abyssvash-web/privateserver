import { NextResponse } from "next/server";
import { LINKS } from "@/config/links";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROMO = new URL(LINKS.register).searchParams.get("promo") ?? "";

const REGISTER_API = "https://api.astymir.com/auth/register";

const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET;
const TURNSTILE_VERIFY =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

type ApiResult =
  | { ok: true }
  | { ok: false; kind: "field"; message: string }
  | { ok: false; kind: "system"; message?: string };

function field(message: string): NextResponse<ApiResult> {
  return NextResponse.json({ ok: false, kind: "field", message });
}

function system(message?: string): NextResponse<ApiResult> {
  return NextResponse.json({ ok: false, kind: "system", message });
}

function extractErrorMessage(data: Record<string, unknown>): string | null {
  const pick = (v: unknown): string | null => {
    if (typeof v === "string" && v.trim()) return v;

    if (Array.isArray(v)) {
      for (const item of v) {
        const s = pick(item);
        if (s) return s;
      }
    }

    if (v && typeof v === "object") {
      for (const val of Object.values(v as Record<string, unknown>)) {
        const s = pick(val);
        if (s) return s;
      }
    }

    return null;
  };

  return pick(data.error) ?? pick(data.errors) ?? pick(data.message);
}

function toCookieHeader(setCookies: string[]): string {
  return setCookies
    .map((c) => c.split(";")[0]?.trim())
    .filter(Boolean)
    .join("; ");
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;

  try {
    body = await req.json();
  } catch {
    return system("Invalid request body.");
  }

  const username =
    typeof body.username === "string" ? body.username.trim() : "";

  const email =
    typeof body.email === "string" ? body.email.trim() : "";

  const password =
    typeof body.password === "string" ? body.password : "";

  const turnstileToken =
    typeof body.turnstileToken === "string"
      ? body.turnstileToken
      : "";

  if (!username || !email || !password) {
    return field("Missing required fields.");
  }

  try {
    // ---------------------------------------------------------
    // STEP 1 — Turnstile
    // ---------------------------------------------------------

    if (!TURNSTILE_SECRET) {
      console.error("TURNSTILE_SECRET is missing.");
      return system("Server captcha configuration is missing.");
    }

    const tsRes = await fetch(TURNSTILE_VERIFY, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        secret: TURNSTILE_SECRET,
        response: turnstileToken,
      }),
      cache: "no-store",
    });

    const tsData = (await tsRes.json().catch(() => null)) as {
      success?: boolean;
      "error-codes"?: string[];
    } | null;

    if (!tsRes.ok || !tsData?.success) {
      console.error("TURNSTILE FAILED:", tsData);

      return field(
        "Captcha verification failed. Please try again."
      );
    }

    // ---------------------------------------------------------
    // STEP 2 — Get Astymir registration page / ssid
    // ---------------------------------------------------------

    const stepA = await fetch(LINKS.register, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
    });

    console.log("STEP A STATUS:", stepA.status);
    console.log("STEP A LOCATION:", stepA.headers.get("location"));

    const location = stepA.headers.get("location");

    if (!location) {
      console.error(
        "STEP A FAILED: No Location header."
      );

      return system(
        "Registration service did not provide an ssid."
      );
    }

    const ssid = new URL(
      location,
      LINKS.register
    ).searchParams.get("ssid");

    console.log("STEP A SSID:", ssid ? "FOUND" : "MISSING");

    if (!ssid) {
      console.error(
        "STEP A FAILED: ssid missing from redirect."
      );

      return system(
        "Registration session could not be created."
      );
    }

    // ---------------------------------------------------------
    // STEP 3 — Extract cookies
    // ---------------------------------------------------------

    const getSetCookie = (
      stepA.headers as unknown as {
        getSetCookie?: () => string[];
      }
    ).getSetCookie;

    const setCookies =
      typeof getSetCookie === "function"
        ? getSetCookie.call(stepA.headers)
        : stepA.headers.get("set-cookie")
          ? [stepA.headers.get("set-cookie") as string]
          : [];

    const cookieHeader = toCookieHeader(setCookies);

    console.log(
      "STEP A COOKIES:",
      cookieHeader ? "FOUND" : "NONE"
    );

    // ---------------------------------------------------------
    // STEP 4 — Astymir /auth/register
    // ---------------------------------------------------------

    const headers: Record<string, string> = {
      "content-type": "application/json",
      origin: "https://api.astymir.com",
    };

    if (cookieHeader) {
      headers.cookie = cookieHeader;
    }

    const requestBody = {
      username,
      email,
      password,
      ssid,
      promo: PROMO,
    };

    console.log(
      "STEP B PROMO:",
      PROMO ? "FOUND" : "MISSING"
    );

    console.log(
      "STEP B SSID:",
      ssid ? "FOUND" : "MISSING"
    );

    const stepB = await fetch(REGISTER_API, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      cache: "no-store",
    });

    console.log(
      "STEP B STATUS:",
      stepB.status
    );

    const rawResponse = await stepB.text();

    console.log(
      "STEP B RESPONSE:",
      rawResponse
    );

    let data: Record<string, unknown> | null = null;

    try {
      data = JSON.parse(rawResponse) as Record<
        string,
        unknown
      >;
    } catch {
      return system(
        `Astymir returned an invalid response. HTTP ${stepB.status}.`
      );
    }

    // ---------------------------------------------------------
    // STEP 5 — Astymir response
    // ---------------------------------------------------------

    if (
      data.status === 1 &&
      (data.error === null ||
        data.error === undefined)
    ) {
      console.log(
        "REGISTRATION SUCCESS:",
        username
      );

      return NextResponse.json({
        ok: true,
      } satisfies ApiResult);
    }

    const message = extractErrorMessage(data);

    if (message) {
      console.error(
        "ASTYMIR REGISTRATION ERROR:",
        message
      );

      return field(message);
    }

    console.error(
      "ASTYMIR UNKNOWN RESPONSE:",
      data
    );

    return system(
      `Astymir rejected the registration. HTTP ${stepB.status}.`
    );
  } catch (error) {
    console.error(
      "REGISTER ROUTE ERROR:",
      error
    );

    return system(
      "Registration server error."
    );
  }
}
