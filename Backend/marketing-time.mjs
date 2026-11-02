export const CLEANER_REPORT_TIMEZONE='Asia/Shanghai';
export function reportingDate(time,timezone=CLEANER_REPORT_TIMEZONE){return new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(time));}
export function platformDateFilters(data,filters={}){
 const timezone=data.meta?.timezone||CLEANER_REPORT_TIMEZONE;
 if(![1,7,30,90,180,365,730].includes(filters.rangeDays))return {...filters,timezone};
 const end=reportingDate(data.now,timezone),start=new Date(Date.parse(end+'T00:00:00Z')-(filters.rangeDays-1)*86400000).toISOString().slice(0,10);
 return {...filters,start,end,timezone};
}
