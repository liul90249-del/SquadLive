// Update existing nodes so polling does not reset scroll, focus or disclosure state.
export function patchHTML(host, html) {
  const template=host.ownerDocument.createElement('template');
  template.innerHTML=html;
  function patch(parent, desired) {
    const next=[...desired.childNodes];
    for(let i=0;i<next.length;i++) {
      const old=parent.childNodes[i], fresh=next[i];
      if(!old) {parent.appendChild(fresh.cloneNode(true));continue;}
      if(old.nodeType!==fresh.nodeType || old.nodeName!==fresh.nodeName ||
         (old.nodeType===1 && old.id!==fresh.id)) {
        old.replaceWith(fresh.cloneNode(true));continue;
      }
      if(old.nodeType!==1) {
        if(old.nodeValue!==fresh.nodeValue)old.nodeValue=fresh.nodeValue;
        continue;
      }
      for(const attr of [...old.attributes]) {
        if(old.tagName==='DETAILS'&&attr.name==='open')continue;
        if(!fresh.hasAttribute(attr.name))old.removeAttribute(attr.name);
      }
      for(const attr of [...fresh.attributes]) {
        if(old.tagName==='DETAILS'&&attr.name==='open')continue;
        if(old.getAttribute(attr.name)!==attr.value)old.setAttribute(attr.name,attr.value);
      }
      patch(old,fresh);
    }
    while(parent.childNodes.length>next.length)parent.lastChild.remove();
  }
  patch(host,template.content);
}
