// Vercel Serverless Function
// File: /api/register.js
//
// Required Vercel environment variable:
// TURNSTILE_SECRET = your Cloudflare Turnstile SECRET KEY
//
// The public site key belongs in index.html.
// Never put TURNSTILE_SECRET in index.html or any client-side JavaScript.

const REGISTER_PAGE =
  "https://api.astymir.com/passport/register?promo=AYC4255C0FD3FC";

const REGISTER_API = "https://api.astymir.com/auth/register";
const TURNSTILE_VERIFY =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const PROMO = new URL(REGISTER_PAGE).searchParams.get("promo") || "";

function send(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function field(res, message) {
  return send(res, 400, { ok: false, kind: "field", message });
}

function system(res) {
  return send(res, 500, { ok: false, kind: "system" });
}

function extractErrorMessage(data) {
  const pick = (value) => {
    if (typeof value === "string" && value.trim()) return value;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = pick(item);
        if (found) return found;
      }
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value)) {
        const found = pick(item);
        if (found) return found;
      }
    }
    return null;
  };

  return pick(data && data.error) ||
         pick(data && data.errors) ||
         pick(data && data.message);
}

function getCookieHeader(response) {
  // Node/Vercel runtimes may expose getSetCookie().
  if (typeof response.headers.getSetCookie === "function") {
    return response.headers
      .getSetCookie()
      .map((c) => c.split(";")[0].trim())
      .filter(Boolean)
      .join("; ");
  }

  const single = response.headers.get("set-cookie");
  return single ? single.split(";")[0].trim() : "";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { ok: false, kind: "system" });
  }

  const body = req.body || {};

  const username =
    typeof body.username === "string" ? body.username.trim() : "";
  const email =
    typeof body.email === "string" ? body.email.trim() : "";
  const password =
    typeof body.password === "string" ? body.password : "";
  const turnstileToken =
    typeof body.turnstileToken === "string" ? body.turnstileToken : "";

  if (!username || !email || !password) {
    return field(res, "Missing required fields.");
  }

  if (!/^[A-Za-z0-9_]{3,32}$/.test(username)) {
    return field(
      res,
      "Username must be 3–32 characters: letters, numbers, underscore."
    );
  }

  if (password.length < 6) {
    return field(res, "Password must be at least 6 characters.");
  }

  if (!turnstileToken) {
    return field(res, "Captcha verification is required.");
  }

  const secret = process.env.TURNSTILE_SECRET;
  if (!secret) {
    console.error("TURNSTILE_SECRET is not configured in Vercel.");
    return system(res);
  }

  try {
    // 1) Verify Cloudflare Turnstile on the server.
    const tsRes = await fetch(TURNSTILE_VERIFY, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        secret,
        response: turnstileToken,
      }),
    });

    const tsData = await tsRes.json().catch(() => null);

    if (!tsRes.ok || !tsData || !tsData.success) {
      return field(
        res,
        "Captcha verification failed. Please try again."
      );
    }

    // 2) Open the official referral registration page to obtain ssid + cookies.
    const stepA = await fetch(REGISTER_PAGE, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
    });

    const location = stepA.headers.get("location");
    if (!location) {
      console.error("Astral referral page did not return a redirect location.");
      return system(res);
    }

    const ssid = new URL(location, REGISTER_PAGE).searchParams.get("ssid");
    if (!ssid) {
      console.error("Astral referral redirect did not contain ssid.");
      return system(res);
    }

    const cookieHeader = getCookieHeader(stepA);

    // 3) Submit the account to the official Astral auth endpoint
    //    with the referral promo from the working project.
    const headers = {
      "content-type": "application/json",
    };

    if (cookieHeader) {
      headers.cookie = cookieHeader;
    }

    const stepB = await fetch(REGISTER_API, {
      method: "POST",
      headers,
      body: JSON.stringify({
        username,
        email,
        password,
        ssid,
        promo: PROMO,
      }),
      cache: "no-store",
    });

    if (!stepB.ok) {
      console.error("Astral auth API returned HTTP", stepB.status);
      return system(res);
    }

    const data = await stepB.json().catch(() => null);

    if (
      data &&
      data.status === 1 &&
      data.error == null
    ) {
      return send(res, 200, { ok: true });
    }

    const message = extractErrorMessage(data);

    if (message) {
      return field(res, message);
    }

    return system(res);
  } catch (error) {
    console.error("Astral registration error:", error);
    return system(res);
  }
}
