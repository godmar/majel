import { createCookie, createCookieSessionStorage } from "react-router";
import { env, isProduction } from "./env.server";

export interface SessionData {
  userId: number;
  username: string;
}

export const sessionStorage = createCookieSessionStorage<SessionData>({
  cookie: {
    name: "__c2c_session",
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secrets: [env.SESSION_SECRET],
    secure: isProduction,
    maxAge: 60 * 60 * 24 * 7, // one week
  },
});

export const { getSession, commitSession, destroySession } = sessionStorage;

// Where to send the user after the CAS round-trip. The CAS `service` URL must
// be byte-identical at login and validation, so the destination cannot ride
// along as a query parameter — it goes in a short-lived cookie instead.
export const returnToCookie = createCookie("__c2c_return_to", {
  httpOnly: true,
  path: "/",
  sameSite: "lax",
  secure: isProduction,
  maxAge: 600,
});
