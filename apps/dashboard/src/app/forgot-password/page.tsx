"use client";

import { useActionState } from "react";
import Link from "next/link";
import { requestPasswordReset, type ForgotPasswordState } from "./actions";

const initialState: ForgotPasswordState = {};

export default function ForgotPasswordPage() {
  const [state, formAction, pending] = useActionState(requestPasswordReset, initialState);

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-950 px-4">
      {state?.sent ? (
        <div className="w-full max-w-sm space-y-4 rounded-lg border border-neutral-800 bg-neutral-900 p-8 text-center">
          <h1 className="text-lg font-semibold text-neutral-100">Check your email</h1>
          <p className="text-sm text-neutral-400">
            If an account exists for that address, a password reset link is on its way.
          </p>
          <Link href="/login" className="text-sm text-neutral-300 underline">
            Back to sign in
          </Link>
        </div>
      ) : (
        <form
          action={formAction}
          className="w-full max-w-sm space-y-4 rounded-lg border border-neutral-800 bg-neutral-900 p-8"
        >
          <h1 className="text-lg font-semibold text-neutral-100">Reset your password</h1>

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

          {state?.error && <p className="text-sm text-red-400">{state.error}</p>}

          <button
            type="submit"
            disabled={pending}
            className="w-full rounded bg-neutral-100 px-3 py-2 font-medium text-neutral-900 disabled:opacity-50"
          >
            {pending ? "Sending..." : "Send reset link"}
          </button>

          <Link href="/login" className="block text-center text-sm text-neutral-400 underline">
            Back to sign in
          </Link>
        </form>
      )}
    </div>
  );
}
