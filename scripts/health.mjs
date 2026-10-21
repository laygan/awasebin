const response=await fetch('http://127.0.0.1:3000/health/ready',{signal:AbortSignal.timeout(10000)});
if(!response.ok)throw new Error('Awasebin readiness failed');
console.log('Awasebin ready');
