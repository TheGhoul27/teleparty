"use client";

import { useId, type InputHTMLAttributes, type ReactNode } from "react";

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: ReactNode;
  error?: string | null;
}

/** Labelled input with hint and inline error, wired for screen readers. */
export function Field({ label, hint, error, className = "", ...props }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-gray-200">
        {label}
      </label>
      <input
        id={id}
        aria-describedby={hint ? hintId : undefined}
        aria-errormessage={error ? errorId : undefined}
        aria-invalid={error ? true : undefined}
        className={`rounded-lg border border-surface-700 bg-surface-900 px-3 py-2 text-gray-100 placeholder:text-gray-500 focus:border-accent-400 ${className}`}
        {...props}
      />
      {hint ? (
        <p id={hintId} className="text-xs text-gray-400">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-red-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}
