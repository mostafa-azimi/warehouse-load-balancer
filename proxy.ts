import { NextRequest, NextResponse } from "next/server";

function unauthorized(message = "Authentication required") {
  return new NextResponse(message, {
    status: 401,
    headers: {
      "Cache-Control": "no-store",
      "WWW-Authenticate": 'Basic realm="Warehouse Load Balancer", charset="UTF-8"',
    },
  });
}

export function proxy(request: NextRequest) {
  const expectedUsername = process.env.APP_USERNAME;
  const expectedPassword = process.env.APP_PASSWORD;

  if (!expectedUsername || !expectedPassword) {
    return new NextResponse("Application access has not been configured.", {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Basic ")) return unauthorized();

  try {
    const decoded = atob(authorization.slice(6));
    const separator = decoded.indexOf(":");
    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);
    if (separator === -1 || username !== expectedUsername || password !== expectedPassword) {
      return unauthorized("Invalid credentials");
    }
  } catch {
    return unauthorized("Invalid credentials");
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
