import { NextResponse } from "next/server";
import { apiSession, type Session } from "@/lib/auth";

export function json<T>(data: T, init?: number | ResponseInit) {
  return NextResponse.json(data, typeof init === "number" ? { status: init } : init);
}

export function fail(status: number, message: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: message, ...extra }, { status });
}

type Ctx<P> = { params: Promise<P> };

/** Wrap a route handler so it only runs for an authenticated workspace. */
export function authed<P = Record<string, never>>(handler: (req: Request, session: Session, params: P) => Promise<Response> | Response) {
  return async (req: Request, ctx: Ctx<P>) => {
    const session = await apiSession(req);
    if (!session) return fail(401, "Sign in or provide an API key (Authorization: Bearer pls_…).");
    try {
      return await handler(req, session, (await ctx.params) ?? ({} as P));
    } catch (err) {
      console.error(err);
      return fail(500, err instanceof Error ? err.message : "Unexpected error");
    }
  };
}

export function baseUrl(req: Request): string {
  return process.env.PLIMSOLL_PUBLIC_URL?.replace(/\/$/, "") || new URL(req.url).origin;
}
