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
 * 修改单个模型的人民币价（元/百万 token，四段）。
 * 默认按「官方美元价 × 汇率」折算；只有官方调价时才需要在这里手工覆盖。
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

  /** 删除覆盖价，回到官方价（这样以后官方调价能自动跟随）。 */
  const reset = useMutation({
    mutationFn: () => aiApi.clearModelPrice(row!.provider, row!.model),
    onSuccess: () => onSaved(`已恢复「${row?.model}」的官方价`),
    onError: (error: unknown) => onError(error instanceof ApiError ? error.message : '恢复失败'),
  });

  /** 一键按"官方价 × 汇率"填回（汇率取当前计费规则里的值）。 */
  const fillFromOfficial = async (): Promise<void> => {
    if (!row) return;
    try {
      const rules = await aiApi.pricingRules();
      /** 分峰谷的供应商直接取当前时段那一档的人民币价，不再乘汇率。 */
      if (row.officialCny) {
        const tier = row.officialCny[rules.tier];
        setPrice({
          input: tier.input,
          output: tier.output,
          cacheWrite: tier.input,
          cacheRead: tier.cacheRead,
        });
        return;
      }
      if (!row.officialUsd) {
        onError('该模型没有收录官方价，请手工填写');
        return;
      }
      setPrice({
        input: Number((row.officialUsd.input * rules.usdToCny).toFixed(4)),
        output: Number((row.officialUsd.output * rules.usdToCny).toFixed(4)),
        cacheWrite: Number((row.officialUsd.cacheWrite * rules.usdToCny).toFixed(4)),
        cacheRead: Number((row.officialUsd.cacheRead * rules.usdToCny).toFixed(4)),
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
              {row.officialCny ? (
                <>
                  官方价（人民币/百万 token，分峰谷）：高峰 输入 ￥{row.officialCny.peak.input} · 输出 ￥
                  {row.officialCny.peak.output} · 缓存 ￥{row.officialCny.peak.cacheRead}；空闲 输入 ￥
                  {row.officialCny.offpeak.input} · 输出 ￥{row.officialCny.offpeak.output} · 缓存 ￥
                  {row.officialCny.offpeak.cacheRead}。系统按调用时刻自动取对应档位，通常不需要手工改。
                </>
              ) : row.officialUsd ? (
                <>
                  官方价（美元/百万 token）：输入 ${row.officialUsd.input} · 输出 ${row.officialUsd.output} · 缓存写入 $
                  {row.officialUsd.cacheWrite} · 缓存读取 ${row.officialUsd.cacheRead}。这里填的是人民币价，默认按「官方价 × 汇率」折算；
                  只有官方调价时才需要手工改。
                </>
              ) : (
                <>该模型没有收录官方价，请手工填写人民币单价。</>
              )}
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
              按官方价 × 汇率 填充
            </Button>
            <Button variant="secondary" size="sm" loading={reset.isPending} disabled={row.source !== 'override'} onClick={() => reset.mutate()}>
              恢复官方价
            </Button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
