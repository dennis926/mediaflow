import { Controller, Get, Post, Query } from '@nestjs/common';
import { Capability } from '../auth/capabilities';
import { MonitorRunResult, OpsMonitorService } from './ops-monitor.service';
import { runtime } from '../settings/runtime-config';

/**
 * 运行监控的人工入口：运维可在后台点一次「立即巡检」，测试也用它做真实触发验证。
 * 只读检查（不修改任何业务数据），因此不需要额外权限，沿用设置写权限。
 */
@Controller('ops/monitor')
export class OpsController {
  constructor(private readonly monitor: OpsMonitorService) {}

  /** 阈值总览：前端展示"当前按什么标准告警"。 */
  @Capability('settings.write')
  @Get('thresholds')
  thresholds() {
    const monitor = runtime().monitor;
    return {
      enabled: monitor.enabled,
      intervalSeconds: monitor.intervalSeconds,
      queueLengthThreshold: monitor.queueLengthThreshold,
      pendingAgeSeconds: monitor.pendingAgeSeconds,
      failureRatePercent: monitor.failureRatePercent,
      failureMinSample: monitor.failureMinSample,
      loginFailThreshold: monitor.loginFailThreshold,
      loginFailWindowMinutes: monitor.loginFailWindowMinutes,
      diskUsedPercent: monitor.diskUsedPercent,
      aiQuotaPercent: monitor.aiQuotaPercent,
      alertCooldownMinutes: monitor.alertCooldownMinutes,
    };
  }

  /** 立即巡检一次；emit=false 时只返回观察结果、不发告警。 */
  @Capability('settings.write')
  @Post('run')
  run(@Query('emit') emit?: string): Promise<MonitorRunResult> {
    return this.monitor.runAll({ emit: emit !== 'false' });
  }
}
