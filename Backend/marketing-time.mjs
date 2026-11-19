export const CLEANER_REPORT_TIMEZONE='Asia/Shanghai';
export const MARKETING_DATE_RANGES=[1,'yesterday',7,30,90,180,365,730];
const formatters=new Map();
export function reportingDate(time,timezone=CLEANER_REPORT_TIMEZONE){
 if(!formatters.has(timezone))formatters.set(timezone,new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}));
 return formatters.get(timezone).format(new Date(time));
}
export function platformDateFilters(data,filters={}){
 const timezone=data.meta?.timezone||CLEANER_REPORT_TIMEZONE;
 if(!MARKETING_DATE_RANGES.includes(filters.rangeDays))return {...filters,timezone};
 const today=reportingDate(data.now,timezone);
 const dateBefore=days=>new Date(Date.parse(today+'T00:00:00Z')-days*86400000).toISOString().slice(0,10);
 const yesterday=filters.rangeDays==='yesterday';
 const end=yesterday?dateBefore(1):today,start=yesterday?end:dateBefore(filters.rangeDays-1);
 return {...filters,start,end,timezone};
}
