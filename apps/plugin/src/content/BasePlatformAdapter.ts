export interface FillPayload {
  title: string;
  body: string;
  tags: string[];
  mediaUrls?: string[];
}

export interface DomLike {
  querySelector(selector: string): ElementLike | null;
  querySelectorAll(selector: string): ArrayLike<ElementLike>;
}

export interface ElementLike {
  textContent: string | null;
  value?: string;
  setAttribute(name: string, value: string): void;
  dispatchEvent(event: unknown): boolean;
  getAttribute?(name: string): string | null;
}

export interface FillReport {
  filled: string[];
  missing: string[];
}

/**
 * Shared behaviour for every content script adapter.
 * Only the editor is filled: the operator always presses publish manually,
 * which keeps the platforms' terms of service intact.
 */
export abstract class BasePlatformAdapter {
  abstract readonly platform: string;
  abstract readonly matches: string[];

  canHandle(url: string): boolean {
    return this.matches.some((pattern) => url.includes(pattern));
  }

  abstract fill(document: DomLike, payload: FillPayload): FillReport;

  protected setValue(element: ElementLike | null, value: string, report: FillReport, field: string): void {
    if (!element) {
      report.missing.push(field);
      return;
    }

    if (typeof element.value === 'string' || 'value' in element) {
      // React/Vue controlled inputs ignore direct assignment, so go through the native setter.
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element) as object, 'value');
      if (descriptor?.set) descriptor.set.call(element, value);
      else element.value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      element.textContent = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }

    element.setAttribute('data-mediaflow-filled', field);
    report.filled.push(field);
  }

  protected findByPlaceholder(document: DomLike, keywords: string[]): ElementLike | null {
    const inputs = Array.from(document.querySelectorAll('input, textarea'));
    for (const input of inputs) {
      const placeholder = `${input.getAttribute?.('placeholder') ?? ''}${input.getAttribute?.('data-placeholder') ?? ''}`;
      if (keywords.some((keyword) => placeholder.includes(keyword))) return input;
    }
    return null;
  }

  protected findEditable(document: DomLike, selectors: string[]): ElementLike | null {
    for (const selector of selectors) {
      const found = document.querySelector(selector);
      if (found) return found;
    }
    return null;
  }
}
