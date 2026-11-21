/**
 * 看门狗（需求 4.1-M6）：独立定时器，固定每 30 秒检查一次。
 * - 自己不调用大脑和工人；只读状态、只发「暂停」指令（通过注入的回调，经 Orchestrator
 *   的命令队列执行，遵守单写者与 M10 去重）。
 * - 对每个运行中的任务检查：总时长（默认 90 分钟）、工人调用总次数（默认 40）、
 *   静默时长（默认 10 分钟没有任何工人输出或事件）、大模型调用总次数（默认 200）。
 *   触发即强制暂停并生成决策卡片（由 Orchestrator 完成）。
 * - 上限可在设置里调整，但不允许设为「无限」（clampConfig 保证）。
 */
import { publish } from "./events";
import { getConfig } from "./config";
import { info } from "./logger";

export const WATCHDOG_TICK_MS = 30000; // 固定 30 秒

export interface WatchdogTaskUsage {
  taskId: string;
  projectDir: string;
  title: string;
  startedAt: string; // 本次进入 running 的时刻
  workerCalls: number;
  brainCalls: number;
  lastActivityAt: string; // 最后一次工人输出或事件
}

export interface WatchdogTrigger {
  taskId: string;
  reason: string; // 中文原因
  detail: string;
}

export class Watchdog {
  private timer: NodeJS.Timeout | null = null;
  private getUsage: () => WatchdogTaskUsage[];
  private onPause: (trigger: WatchdogTrigger) => void;
  private lastTickAt = 0;

  constructor(getUsage: () => WatchdogTaskUsage[], onPause: (t: WatchdogTrigger) => void) {
    this.getUsage = getUsage;
    this.onPause = onPause;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), WATCHDOG_TICK_MS);
    this.timer.unref?.();
    info("watchdog", "看门狗已启动（每 30 秒检查一次）");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 单次检查（也供测试直接调用）。返回触发的暂停列表。 */
  tick(): WatchdogTrigger[] {
    this.lastTickAt = Date.now();
    const cfg = getConfig().watchdog;
    const triggers: WatchdogTrigger[] = [];
    const usages = this.getUsage();
    for (const u of usages) {
      const mins = (Date.now() - new Date(u.startedAt).getTime()) / 60000;
      if (mins > cfg.maxTotalMinutes) {
        triggers.push({ taskId: u.taskId, reason: "总时长超限", detail: `任务已运行 ${Math.round(mins)} 分钟，超过上限 ${cfg.maxTotalMinutes} 分钟` });
        continue;
      }
      if (u.workerCalls > cfg.maxWorkerCalls) {
        triggers.push({ taskId: u.taskId, reason: "工人调用次数超限", detail: `工人已调用 ${u.workerCalls} 次，超过上限 ${cfg.maxWorkerCalls} 次` });
        continue;
      }
      if (u.brainCalls > cfg.maxBrainCalls) {
        triggers.push({ taskId: u.taskId, reason: "大脑调用次数超限", detail: `大脑已调用 ${u.brainCalls} 次，超过上限 ${cfg.maxBrainCalls} 次` });
        continue;
      }
      const silenceMin = (Date.now() - new Date(u.lastActivityAt).getTime()) / 60000;
      if (silenceMin > cfg.maxSilenceMinutes) {
        triggers.push({ taskId: u.taskId, reason: "任务静默超限", detail: `已 ${Math.round(silenceMin)} 分钟没有任何工人输出或事件，超过上限 ${cfg.maxSilenceMinutes} 分钟` });
        continue;
      }
    }
    // 推送看门狗状态事件（右栏展示已用时长/调用数与上限对照；watchdog 事件永远不唤醒大脑）
    for (const u of usages) {
      publish({
        type: "watchdog",
        taskId: u.taskId,
        usage: {
          title: u.title,
          totalMinutes: Math.round(((Date.now() - new Date(u.startedAt).getTime()) / 60000) * 10) / 10,
          maxTotalMinutes: cfg.maxTotalMinutes,
          workerCalls: u.workerCalls,
          maxWorkerCalls: cfg.maxWorkerCalls,
          brainCalls: u.brainCalls,
          maxBrainCalls: cfg.maxBrainCalls,
          silenceMinutes: Math.round(((Date.now() - new Date(u.lastActivityAt).getTime()) / 60000) * 10) / 10,
          maxSilenceMinutes: cfg.maxSilenceMinutes,
        },
      });
    }
    for (const t of triggers) {
      this.onPause(t);
    }
    return triggers;
  }
}
