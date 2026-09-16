'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './ui.module.css';
import { cn } from './utils';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'text';
export type ButtonSize = 'lg' | 'md' | 'sm';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  fullWidth?: boolean;
  icon?: ReactNode;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: styles.primary,
  secondary: styles.secondary,
  danger: styles.danger,
  text: styles.text,
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  lg: styles.sizeLg,
  md: styles.sizeMd,
  sm: styles.sizeSm,
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  fullWidth = false,
  icon,
  children,
  className,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={rest.type ?? 'button'}
      className={cn(styles.button, VARIANT_CLASS[variant], SIZE_CLASS[size], fullWidth && styles.fullWidth, className)}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <span className={styles.spinner} aria-hidden /> : icon}
      {children}
    </button>
  );
}
