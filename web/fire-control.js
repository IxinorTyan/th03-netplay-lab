// Five presses per second = one cycle per 12 frames at 60 Hz.
// Two pressed frames, ten released frames; native shots need >=3 released frames.
export class FireControl {
  constructor(){this.reset();}
  reset(){this.state={held:false,next:0,until:0,charging:false};}
  sample(rapid,charge,now,playing=true){
    const s=this.state;
    if(!playing){this.reset();return rapid||charge;}
    if(charge){s.held=false;s.until=0;s.charging=true;return true;}
    // Always let the native key go up after charge, even with rapid held.
    if(s.charging){s.charging=false;s.next=now+200/3;s.until=0;s.held=rapid;return false;}
    if(rapid&&(!s.held||now>=s.next-0.001)){
      s.until=now+100/3;s.next=now+200;
    }
    s.held=rapid;
    return now<s.until-0.001;
  }
}
