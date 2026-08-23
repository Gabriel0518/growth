/**
 * 拼 className，丢掉 false / null / undefined。
 * 刻意不引 clsx 或 tailwind-merge —— 全仓只有设计系统这一处用得上，
 * 为它加两个运行时依赖不划算；组件内部自己保证不产生冲突的工具类。
 */
export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ');
}
