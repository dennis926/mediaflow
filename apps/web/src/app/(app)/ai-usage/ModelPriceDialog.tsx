'use client';

import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Banner } from '../../../components/ui/Banner';
import { Button } from '../../../components/ui/Button';
import { Dialog } from '../../../components/ui/Dialog';
import { Input } from '../../../components/ui/Field';
import { ApiError } from '../../../lib/api/client';
import { aiApi } from '../../../lib/api/endpoints';
import type { AiUsageModelRow, ModelPriceCnyView } from '../../../lib/api/types';
import styles from './page.module.css';

export interface ModelPriceDialogProps {
  open: boolean;
  row: AiUsageModelRow | null;
  onClose: () => void;
  onSaved: (message: string) => void;
  onError: (message: string) => void;
}

const EMPTY: ModelPriceCnyView = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

/**
 * 修改单个模型的实付价（元/百万 token，四段）。
 * 中转站的分组价与官方价不同，这里填的就是你的实际结算价，用量页会据此算钱。
 */
export function ModelPriceDialog({ open, row, onClose, onSaved, onError }: ModelPriceDialogProps) {
  const [price, setPrice] = useState<ModelPriceCnyView>(EMPTY);

  useEffect(() => {
    if (!open) return;
    setPrice(row ? { ...row.price } : { ...EMPTY });
  }, [open, row]);

  const save = useMutation({
    mutationFn: () => aiApi.setModelPrice({ provider: row!.provider, model: row!.model, price }),
    onSuccess: () => onSaved(`已更新「${row?.model}」的价格`),
    onError: (error: unknown) => onError(error instanceof ApiError ? error.message : '保存失败'),
  });

  /** 一键按"官方价 × 汇率 × 倍率"填回（汇率取当前计费规则里的值）。 */
  const fillFromOfficial = async (): Promise<void> => {
    if (!row) return;
    try {
      const rules = await aiApi.pricingRules();
      setPrice({
        input: Number((row.officialUsd.input * rules.usdToCny * row.multiplier).toFixed(4)),
        output: Number((row.officialUsd.output * rules.usdToCny * row.multiplier).toFixed(4)),
        cacheWrite: Number((row.officialUsd.cacheWrite * rules.usdToCny * row.multiplier).toFixed(4)),
        cacheRead: Number((row.officialUsd.cacheRead * rules.usdToCny * row.multiplier).toFixed(4)),
      });
    } catch (error) {
      onError(error instanceof ApiError ? error.message : '读取计费规则失败');
    }
  };

  return (
    <Dialog
      open={open}
      title={row ? `修改价格：${row.model}` : '修改价格'}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button loading={save.isPending} disabled={!row} onClick={() => save.mutate()}>
            保存价格
          </Button>
        </>
      }
    >
      {row ? (
        <div className={styles.form}>
          <Banner tone="info">
            <span>
              官方价（美元/百万 token）：输入 ${row.officialUsd.input} · 输出 ${row.officialUsd.output} · 缓存写入 ${row.officialUsd.cacheWrite} · 缓存读取 $
              {row.officialUsd.cacheRead}。填这里的实付价会覆盖官方折算结果，用于对齐你在中转站的真实账单。
            </span>
          </Banner>
          <div className={styles.twoCol}>
            <Input label="输入（元/百万 token）" name="priceInput" type="number" value={String(price.input)} onChange={(event) => setPrice({ ...price, input: Number(event.target.value) })} />
            <Input label="输出（元/百万 token）" name="priceOutput" type="number" value={String(price.output)} onChange={(event) => setPrice({ ...price, output: Number(event.target.value) })} />
          </div>
          <div className={styles.twoCol}>
            <Input
              label="缓存写入（元/百万 token）"
              name="priceCacheWrite"
              type="number"
              value={String(price.cacheWrite)}
              onChange={(event) => setPrice({ ...price, cacheWrite: Number(event.target.value) })}
            />
            <Input
              label="缓存读取（元/百万 token）"
              name="priceCacheRead"
              type="number"
              value={String(price.cacheRead)}
              onChange={(event) => setPrice({ ...price, cacheRead: Number(event.target.value) })}
            />
          </div>
          <div className={styles.reviewToolbar}>
            <Button variant="secondary" size="sm" onClick={() => void fillFromOfficial()}>
              按官方价 × 汇率 × 倍率 填充
            </Button>
            <span className={styles.meta}>当前倍率 {row.multiplier}（在供应商配置里可改）</span>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
