"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "danger" | "ghost";
type Size = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const variantClasses: Record<Variant, string> = {
  primary:
    "bg-accent-500 hover:bg-accent-400 text-white disabled:bg-surface-700 disabled:text-gray-500",
  secondary:
    "bg-surface-700 hover:bg-surface-800 text-gray-100 border border-surface-700 disabled:text-gray-500",
  danger: "bg-red-600 hover:bg-red-500 text-white disabled:bg-surface-700 disabled:text-gray-500",
  ghost: "bg-transparent hover:bg-surface-800 text-gray-300 disabled:text-gray-600"
};

const sizeClasses: Record<Size, string> = {
  sm: "px-2.5 py-1.5 text-sm rounded-md",
  md: "px-4 py-2 text-sm rounded-lg",
  lg: "px-5 py-3 text-base rounded-lg"
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", className = "", type = "button", ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`inline-flex items-center justify-center gap-2 font-medium transition-colors disabled:cursor-not-allowed ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
      {...props}
    />
  );
});
