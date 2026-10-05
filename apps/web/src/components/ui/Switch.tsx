'use client';

import { useId } from 'react';
import styles from './ui.module.css';

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  hint?: string;
  disabled?: boolean;
  /** 开关右侧的说明文字（例如「已就绪」「待完善」）。 */
  extra?: React.ReactNode;
  name?: string;
}

/**
 * 开关。用于「通知渠道」「平台密钥」这类"打开才展开编辑"的场景。
 *
 * 用 button + role="switch" 而不是 checkbox：既保留原生语义（读屏可用），
 * 又能完全用 Design Token 控制外观，不受各浏览器默认 checkbox 样式影响。
 */
export function Switch({ checked, onChange, label, hint, disabled, extra, name }: SwitchProps) {
  const id = useId();
  return (
    <div className={styles.switchRow}>
      <button
        type="button"
        id={id}
        name={name}
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        className={`${styles.switch} ${checked ? styles.switchOn : ''}`}
        onClick={() => onChange(!checked)}
      >
        <span className={styles.switchKnob} />
      </button>
      {label ? (
        <label className={styles.switchLabel} htmlFor={id}>
          <span className={styles.switchTitle}>{label}</span>
          {hint ? <span className={styles.switchHint}>{hint}</span> : null}
        </label>
      ) : null}
      {extra ? <span className={styles.switchExtra}>{extra}</span> : null}
    </div>
  );
}

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
  /** 只读展示（例如「所有者」列不可取消勾选）。 */
  tone?: 'default' | 'danger';
  title?: string;
}

/** 勾选框。权限表里每一格用它。 */
export function Checkbox({ checked, onChange, label, disabled, tone = 'default', title }: CheckboxProps) {
  return (
    <label className={`${styles.checkbox} ${disabled ? styles.checkboxDisabled : ''}`} title={title}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className={`${styles.checkboxBox} ${tone === 'danger' ? styles.checkboxDanger : ''}`} aria-hidden />
      {label ? <span className={styles.checkboxLabel}>{label}</span> : null}
    </label>
  );
}
