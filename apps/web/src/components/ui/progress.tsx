import * as React from 'react';
import * as ProgressPrimitive from '@radix-ui/react-progress';
import { cn } from '../../lib/utils';
export const Progress = React.forwardRef<React.ElementRef<typeof ProgressPrimitive.Root>, React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root>>(({ className, value, ...props }, ref) => (
  <ProgressPrimitive.Root ref={ref} className={cn('relative h-1.5 w-full overflow-hidden rounded-full bg-[#e4e7dc]', className)} value={value} {...props}>
    <ProgressPrimitive.Indicator className="h-full w-full flex-1 rounded-full bg-clay transition-all duration-300" style={{ transform: `translateX(-${100 - (value || 0)}%)` }} />
  </ProgressPrimitive.Root>
));
Progress.displayName = 'Progress';
