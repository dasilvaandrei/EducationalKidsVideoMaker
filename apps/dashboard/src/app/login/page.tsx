"use client";

import { Suspense, useActionState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { login, type LoginState } from "./actions";

const initialState: LoginState = {};

function LoginForm() {
  const [state, formAction, pending] = useActionState(login, initialState);
  const linkError = useSearchParams().get("error");

  return (
    <form
      action={formAction}
      className="w-full max-w-sm space-y-4 rounded-lg border border-neutral-800 bg-neutral-900 p-8"
    >
      <h1 className="text-lg font-semibold text-neutral-100">Episode review sign in</h1>

      <div className="space-y-1">
        <label htmlFor="email" className="text-sm text-neutral-400">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          className="w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="password" className="text-sm text-neutral-400">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          className="w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-neutral-100"
        />
      </div>

      {(state?.error ?? linkError) && (
        <p className="text-sm text-red-400">{state?.error ?? linkError}</p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded bg-neutral-100 px-3 py-2 font-medium text-neutral-900 disabled:opacity-50"
      >
        {pending ? "Signing in..." : "Sign in"}
      </button>

      <Link href="/forgot-password" className="block text-center text-sm text-neutral-400 underline">
        Forgot password?
      </Link>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-950 px-4">
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
