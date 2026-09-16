'use client';

import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import styles from './ui.module.css';
import { cn } from './utils';

export interface FieldShellProps {
  label?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  fullWidth?: boolean;
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement>, FieldShellProps {}

export function Input({ label, hint, error, required, className, id, ...rest }: InputProps) {
  const inputId = id ?? rest.name;
  return (
    <div className={styles.field}>
      {label ? (
        <label className={cn(styles.label, required && styles.required)} htmlFor={inputId}>
          {label}
        </label>
      ) : null}
      <input
        id={inputId}
        className={cn(styles.control, error && styles.invalid, className)}
        aria-invalid={Boolean(error)}
        {...rest}
      />
      {error ? <span className={styles.error}>{error}</span> : hint ? <span className={styles.hint}>{hint}</span> : null}
    </div>
  );
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement>, FieldShellProps {}

export function Textarea({ label, hint, error, required, className, id, ...rest }: TextareaProps) {
  const inputId = id ?? rest.name;
  return (
    <div className={styles.field}>
      {label ? (
        <label className={cn(styles.label, required && styles.required)} htmlFor={inputId}>
          {label}
        </label>
      ) : null}
      <textarea
        id={inputId}
        className={cn(styles.control, styles.textarea, error && styles.invalid, className)}
        aria-invalid={Boolean(error)}
        {...rest}
      />
      {error ? <span className={styles.error}>{error}</span> : hint ? <span className={styles.hint}>{hint}</span> : null}
    </div>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement>, FieldShellProps {
  options: SelectOption[];
}

export function Select({ label, hint, error, required, options, className, id, ...rest }: SelectProps) {
  const inputId = id ?? rest.name;
  return (
    <div className={styles.field}>
      {label ? (
        <label className={cn(styles.label, required && styles.required)} htmlFor={inputId}>
          {label}
        </label>
      ) : null}
      <select
        id={inputId}
        className={cn(styles.control, styles.select, error && styles.invalid, className)}
        aria-invalid={Boolean(error)}
        {...rest}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {error ? <span className={styles.error}>{error}</span> : hint ? <span className={styles.hint}>{hint}</span> : null}
    </div>
  );
}
