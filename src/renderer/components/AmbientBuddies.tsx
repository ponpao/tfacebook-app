import React from 'react'

/**
 * AmbientBuddies.tsx — 2 subtle, friendly buddy characters walking along the header border line.
 * Uses 100% GPU-accelerated translate3d transforms with pure CSS keyframes.
 * Zero CPU / zero RAM footprint, pointer-events: none so it never interferes with window drag or clicks.
 */
export function AmbientBuddies(): React.JSX.Element {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 top-0 overflow-hidden z-20 select-none">
      <style>{`
        @keyframes buddy1Walk {
          0% { transform: translate3d(210px, 12px, 0) scaleX(1); }
          18% { transform: translate3d(360px, 12px, 0) scaleX(1); }
          22% { transform: translate3d(360px, 12px, 0) scaleX(1) rotate(6deg); }
          25% { transform: translate3d(370px, 14px, 0) scaleX(1) rotate(-10deg); } /* stumble */
          28% { transform: translate3d(370px, 12px, 0) scaleX(1) rotate(0deg); } /* helped up */
          42% { transform: translate3d(580px, 12px, 0) scaleX(1); } /* steady walk */
          52% { transform: translate3d(740px, 10px, 0) scaleX(1); } /* step up stairs */
          56% { transform: translate3d(770px, 8px, 0) scaleX(1); }
          60% { transform: translate3d(770px, 8px, 0) scaleX(-1); } /* look back */
          75% { transform: translate3d(490px, 12px, 0) scaleX(-1); } /* walk back */
          85% { transform: translate3d(310px, 12px, 0) scaleX(-1); }
          92% { transform: translate3d(220px, 12px, 0) scaleX(-1); }
          96% { transform: translate3d(210px, 12px, 0) scaleX(1); }
          100% { transform: translate3d(210px, 12px, 0) scaleX(1); }
        }

        @keyframes buddy2Walk {
          0% { transform: translate3d(180px, 14px, 0) scaleX(1); }
          16% { transform: translate3d(335px, 14px, 0) scaleX(1); }
          22% { transform: translate3d(345px, 14px, 0) scaleX(1); } /* stops near friend */
          27% { transform: translate3d(355px, 12px, 0) scaleX(1) scale(1.1); } /* cheer/help up */
          31% { transform: translate3d(355px, 14px, 0) scaleX(1) scale(1); }
          40% { transform: translate3d(550px, 14px, 0) scaleX(1); } /* short sprint */
          50% { transform: translate3d(715px, 12px, 0) scaleX(1); } /* stairs */
          55% { transform: translate3d(745px, 10px, 0) scaleX(1); }
          61% { transform: translate3d(745px, 10px, 0) scaleX(-1); } /* flip */
          76% { transform: translate3d(470px, 14px, 0) scaleX(-1); }
          86% { transform: translate3d(280px, 14px, 0) scaleX(-1); }
          93% { transform: translate3d(190px, 14px, 0) scaleX(-1); }
          97% { transform: translate3d(180px, 14px, 0) scaleX(1); }
          100% { transform: translate3d(180px, 14px, 0) scaleX(1); }
        }

        @keyframes buddyBob {
          0%, 100% { transform: translateY(0px); }
          50% { transform: translateY(-2.5px); }
        }

        .buddy-tall {
          animation: buddy1Walk 42s cubic-bezier(0.45, 0.05, 0.55, 0.95) infinite;
          will-change: transform;
        }

        .buddy-short {
          animation: buddy2Walk 42s cubic-bezier(0.45, 0.05, 0.55, 0.95) infinite;
          will-change: transform;
        }

        .buddy-bob-1 {
          animation: buddyBob 0.6s ease-in-out infinite;
        }

        .buddy-bob-2 {
          animation: buddyBob 0.5s ease-in-out infinite;
        }
      `}</style>

      {/* Buddy 1: Taller companion (~22px, friendly purple-blue bot with antenna) */}
      <div className="buddy-tall absolute left-0 top-0 flex flex-col items-center opacity-85 hover:opacity-100 transition-opacity">
        <div className="buddy-bob-1 flex flex-col items-center">
          {/* Antenna */}
          <div className="h-1.5 w-0.5 bg-indigo-500 rounded-full mb-[0.5px]">
            <div className="-mt-1 -ml-[1.5px] h-1.5 w-1.5 rounded-full bg-pink-500 shadow-xs" />
          </div>
          {/* Body */}
          <div className="relative flex h-[16px] w-[15px] items-center justify-center rounded-t-md rounded-b-[4px] bg-gradient-to-b from-indigo-600 to-purple-600 shadow-2xs border border-indigo-700/50">
            {/* Eyes */}
            <div className="flex gap-[3px]">
              <div className="h-1.5 w-1 rounded-full bg-cyan-200 shadow-xs animate-pulse" />
              <div className="h-1.5 w-1 rounded-full bg-cyan-200 shadow-xs animate-pulse" />
            </div>
            {/* Smile */}
            <div className="absolute bottom-[2px] h-[1px] w-[5px] bg-indigo-200/80 rounded-full" />
          </div>
          {/* Feet */}
          <div className="flex gap-1.5 -mt-[1px]">
            <div className="h-1 w-1.5 rounded-full bg-indigo-800" />
            <div className="h-1 w-1.5 rounded-full bg-indigo-800" />
          </div>
        </div>
      </div>

      {/* Buddy 2: Shorter companion (~17px, cute golden-amber round critter) */}
      <div className="buddy-short absolute left-0 top-0 flex flex-col items-center opacity-85 hover:opacity-100 transition-opacity">
        <div className="buddy-bob-2 flex flex-col items-center">
          {/* Ears/Tuft */}
          <div className="flex gap-1 -mb-[1px]">
            <div className="h-1 w-1 rounded-t-full bg-amber-500" />
            <div className="h-1 w-1 rounded-t-full bg-amber-500" />
          </div>
          {/* Body */}
          <div className="relative flex h-[13px] w-[13px] items-center justify-center rounded-full bg-gradient-to-b from-amber-400 to-amber-500 shadow-2xs border border-amber-600/40">
            {/* Eyes */}
            <div className="flex gap-1">
              <div className="h-1 w-1 rounded-full bg-slate-900" />
              <div className="h-1 w-1 rounded-full bg-slate-900" />
            </div>
            {/* Rosy cheeks */}
            <div className="absolute bottom-1 flex justify-between w-[9px]">
              <div className="h-[2px] w-[2px] rounded-full bg-rose-400/90" />
              <div className="h-[2px] w-[2px] rounded-full bg-rose-400/90" />
            </div>
          </div>
          {/* Tiny feet */}
          <div className="flex gap-1 -mt-[0.5px]">
            <div className="h-[3px] w-1 rounded-full bg-amber-700" />
            <div className="h-[3px] w-1 rounded-full bg-amber-700" />
          </div>
        </div>
      </div>

      {/* Faint subtle stairs graphic near the right side window controls */}
      <div className="absolute right-[145px] top-[14px] flex items-end opacity-25">
        <div className="h-[4px] w-[10px] border-t border-l border-amber-600/60" />
        <div className="h-[8px] w-[10px] border-t border-l border-amber-600/60" />
        <div className="h-[12px] w-[10px] border-t border-l border-r border-amber-600/60" />
      </div>
    </div>
  )
}
