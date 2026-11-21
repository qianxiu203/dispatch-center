import { LoopRecord } from "../tasks/store";
import { EMPTY_SIGNATURE } from "./signature";
import { info, warn } from "../logger";

/**
 * 循环预算组件 LoopGuard（需求 4.1-M1，最高优先级）：
 * - 系统里任何「重试、修复、重新生成、轮询、自动回复、自动恢复」都必须先创建预算、
 *   每次迭代前调用 permit()，拒绝时走该循环登记的停止去向（M5）。
 * - permit 与 record 都落盘（写入任务文件的 loops 字段），重启程序不重置计数。
 * - M4 次数语义：上限 N = 最多执行 N 次动作；第 N 次动作之后仍未成功，立即停止，
 *   不得发起第 N+1 次（一期 bug：要到第 4 轮才触发，本组件从语义上排除该错误）。
 * - M3 振荡检测：记录最近 8 个签名；同一签名重现达 2 次，或出现 A→B→A，判定无进展。
 * - M2 进展判据：签名变化且不在最近 8 个签名里，或修复后失败集合变小；EMPTY 永不合法。
 *
 * 使用方式：orchestrator 为每个任务持有一个 LoopGuard 实例，构造时注入读取任务与持久化的回调。
 */

export interface PermitDecision {
  allowed: boolean;
  reason?: string; // 拒绝时的中文原因（用于决策卡片与日志）
}

export interface LoopOptions {
  loopId: string;
  kind: string; // L1..L13 中的种类标识
  maxIterations: number; // M4：最多执行的动作次数
  maxNoProgress?: number; // 无进展上限（默认 2）
}

export class LoopGuard {
  private getLoops: () => Record<string, LoopRecord>;
  private persist: () => void;

  constructor(getLoops: () => Record<string, LoopRecord>, persist: () => void) {
    this.getLoops = getLoops;
    this.persist = persist;
  }

  /** 创建（或取回）一个循环预算。重启后 loops 字段仍在，计数自动延续。 */
  begin(opts: LoopOptions): LoopRecord {
    const loops = this.getLoops();
    let rec = loops[opts.loopId];
    if (!rec) {
      rec = {
        loopId: opts.loopId,
        kind: opts.kind,
        iteration: 0,
        maxIterations: opts.maxIterations,
        noProgressCount: 0,
        maxNoProgress: opts.maxNoProgress ?? 2,
        signatures: [],
        permitLog: [],
        startedAt: new Date().toISOString(),
      };
      loops[opts.loopId] = rec;
      this.persist();
      info("loop", `创建循环预算 ${opts.loopId}(${opts.kind}) 上限=${opts.maxIterations}`);
    }
    return rec;
  }

  /** 读取某循环记录（供右栏循环状态展示）。 */
  get(loopId: string): LoopRecord | undefined {
    return this.getLoops()[loopId];
  }

  all(): Record<string, LoopRecord> {
    return this.getLoops();
  }

  /**
   * 申请执行第 iteration+1 次动作。
   * - 拒绝情形 1：已完成的动作次数达到上限（M4 精确语义：第 N 次动作之后不再发起第 N+1 次）。
   * - 拒绝情形 2：无进展次数达到上限。
   * - 拒绝情形 3：签名 EMPTY —— 内容为空的签名永远不是合法的修复输入（L1/M2）。
   * 每次申请都记录进 permitLog 并落盘（需求 17：循环预算的每一次 permit 与 deny 都要记录）。
   */
  permit(loopId: string, signature?: string): PermitDecision {
    const rec = this.getLoops()[loopId];
    if (!rec) return { allowed: false, reason: `循环 ${loopId} 未登记预算` };
    if (rec.stopped) {
      this.logPermit(rec, false, "循环已停止");
      return { allowed: false, reason: rec.stopReason ?? "循环已停止" };
    }
    if (signature === EMPTY_SIGNATURE) {
      this.logPermit(rec, false, "签名为 EMPTY（内容为空），不作为合法的循环输入");
      return { allowed: false, reason: "问题内容为空（签名 EMPTY），按调度侧缺陷处理，不派工人" };
    }
    if (rec.iteration >= rec.maxIterations) {
      this.logPermit(rec, false, `已达上限 ${rec.maxIterations} 次（已执行 ${rec.iteration} 次），停止并交使用者决定`);
      warn("loop", `循环 ${loopId} 达上限：已执行 ${rec.iteration}/${rec.maxIterations}`);
      return { allowed: false, reason: `已达循环上限（${rec.maxIterations} 次）` };
    }
    if (rec.noProgressCount >= rec.maxNoProgress) {
      this.logPermit(rec, false, `连续 ${rec.noProgressCount} 次无进展，停止`);
      return { allowed: false, reason: `连续 ${rec.noProgressCount} 次无进展` };
    }
    this.logPermit(rec, true);
    return { allowed: true };
  }

  /**
   * 记录一次动作的结果签名。返回本签名是否「有进展」：
   * - 签名为 EMPTY：无进展（且按调用方约定 EMPTY 不应出现在这里，防御性处理）。
   * - 同一签名累计出现达 2 次：无进展（M3）。
   * - 最近 8 个签名中出现 A→B→A 振荡：无进展（M3）。
   */
  record(loopId: string, signature: string): { progress: boolean; reason?: string } {
    const rec = this.getLoops()[loopId];
    if (!rec) return { progress: false, reason: "循环未登记" };
    rec.iteration += 1;
    rec.lastSignature = signature;
    rec.signatures.push(signature);
    if (rec.signatures.length > 8) rec.signatures = rec.signatures.slice(-8);

    if (signature === EMPTY_SIGNATURE) {
      rec.noProgressCount += 1;
      this.persist();
      return { progress: false, reason: "签名为 EMPTY" };
    }
    const occurrences = rec.signatures.filter((s) => s === signature).length;
    if (occurrences >= 2) {
      rec.noProgressCount += 1;
      this.persist();
      return { progress: false, reason: `签名 ${signature} 再次出现（第 ${occurrences} 次），判定无进展` };
    }
    // A→B→A 振荡：当前签名与前两个之前的签名相同（…A, B, A）
    const n = rec.signatures.length;
    if (n >= 3 && rec.signatures[n - 1] === rec.signatures[n - 3]) {
      rec.noProgressCount += 1;
      this.persist();
      return { progress: false, reason: "出现 A→B→A 振荡，判定无进展" };
    }
    rec.noProgressCount = 0;
    this.persist();
    return { progress: true };
  }

  /** 登记无进展的额外判据（例如：修复后没有任何文件改动，连续 2 次即判无进展，L1）。 */
  recordNoProgress(loopId: string, reason: string): void {
    const rec = this.getLoops()[loopId];
    if (!rec) return;
    rec.noProgressCount += 1;
    rec.lastNoProgressReason = reason;
    this.persist();
    warn("loop", `循环 ${loopId} 登记无进展(${rec.noProgressCount}/${rec.maxNoProgress})：${reason}`);
  }

  /** 循环停止：登记停止原因（M5 的「确定的停止去向」由调用方执行——暂停 + 决策卡片）。 */
  stop(loopId: string, reason: string): void {
    const rec = this.getLoops()[loopId];
    if (!rec) return;
    rec.stopped = true;
    rec.stopReason = reason;
    this.persist();
    info("loop", `循环 ${loopId} 停止：${reason}`);
  }

  private logPermit(rec: LoopRecord, allowed: boolean, reason?: string): void {
    rec.permitLog.push({ ts: new Date().toISOString(), allowed, reason });
    if (rec.permitLog.length > 200) rec.permitLog = rec.permitLog.slice(-200);
    this.persist();
  }
}
