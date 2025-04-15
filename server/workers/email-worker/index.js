// Cloudflare Worker for handling temporary email service

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// 简化日志
function logInfo(message, data = {}) {
  console.log(`[INFO] ${message}`, data);
}

function logError(message, error) {
  console.error(`[ERROR] ${message}`, error);
}

// KV namespace binding name: tempEmail

async function handleOptions(request) {
  return new Response(null, {
    headers: corsHeaders
  });
}

async function generateEmailAddress(env) {
  try {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let username = '';
    for (let i = 0; i < 8; i++) {
      username += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    // 使用环境变量中的域名
    const domain = env.EMAIL_DOMAIN || "220901.xyz";
    const emailAddress = `${username}@${domain}`;
    
    return emailAddress;
  } catch (error) {
    logError("生成邮箱地址失败");
    throw error;
  }
}

async function handleNewEmail(request, env) {
  try {
    const email = await request.json();
    const timestamp = new Date().getTime();
    
    // 验证必要的邮件字段
    if (!email.from || !email.to || !email.subject) {
      return new Response(JSON.stringify({ error: "缺少必要的邮件字段" }), {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }

    // 确保 text 字段存在 - 如果没有，使用 content 或空字符串
    if (!email.text) {
      email.text = email.content || '';
    }

    // 使用邮箱地址作为键的一部分，确保唯一性
    const emailAddress = email.to.toLowerCase().trim();
    const emailKey = `${emailAddress}:${timestamp}`;
    
    // 检查 KV 绑定是否存在
    if (!env["temp-email"]) {
      logError('KV 绑定不存在: temp-email');
      return new Response(JSON.stringify({ error: 'KV 绑定不存在' }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }
    
    // 保存邮件数据，24小时过期
    await env["temp-email"].put(emailKey, JSON.stringify(email), {
      expirationTtl: 86400 // 24小时
    });

    return new Response(JSON.stringify({ success: true }), {
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      }
    });
  } catch (error) {
    logError('处理新邮件失败');
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      }
    });
  }
}

async function getEmails(request, env) {
  try {
    const { searchParams } = new URL(request.url);
    const address = searchParams.get('address');
    
    if (!address) {
      logError('获取邮件时缺少地址参数');
      return new Response(JSON.stringify({ error: "需要提供邮箱地址" }), {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }
    
    // 检查 KV 绑定是否存在
    if (!env || !env["temp-email"]) {
      logError('KV 绑定不存在: temp-email', { env: !!env });
      return new Response(JSON.stringify({ error: 'KV 绑定不存在', details: 'temp-email binding not found' }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }
    
    const normalizedAddress = address.toLowerCase().trim();
    logInfo(`查询邮件，地址: ${normalizedAddress}`);
    
    try {
      // 直接使用邮箱地址前缀列出所有相关邮件
      logInfo(`开始查询KV，前缀: ${normalizedAddress}:`);
      const allEmails = await env["temp-email"].list({ prefix: `${normalizedAddress}:` });
      logInfo(`KV查询结果，找到 ${allEmails.keys.length} 个键`, { keys: allEmails.keys.map(k => k.name) });
      
      // 处理所有匹配邮件
      const emails = [];
      
      for (const key of allEmails.keys) {
        try {
          logInfo(`获取邮件内容: ${key.name}`);
          const emailData = await env["temp-email"].get(key.name);
          if (emailData) {
            logInfo(`成功获取邮件内容, 大小: ${emailData.length}`);
            const parsedEmail = JSON.parse(emailData);
            // 添加ID，使用时间戳部分
            const timestamp = key.name.split(':')[1];
            emails.push({
              id: timestamp,
              ...parsedEmail
            });
          } else {
            logError(`未找到邮件内容: ${key.name}`);
          }
        } catch (emailError) {
          logError(`解析邮件失败: ${key.name}`, emailError);
        }
      }
      
      // 按时间排序（最新的在前）
      emails.sort((a, b) => b.id - a.id);
      logInfo(`返回 ${emails.length} 封邮件`);
      
      return new Response(JSON.stringify(emails), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    } catch (listError) {
      logError(`列出邮件失败`, listError);
      
      return new Response(JSON.stringify([]), {
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }
  } catch (error) {
    logError(`获取邮件列表失败`, error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      }
    });
  }
}

async function handleRequest(request, env) {
  // 检查 env 对象是否存在
  if (!env) {
    logError('环境变量对象不存在');
    return new Response(JSON.stringify({ error: '服务器配置错误' }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      }
    });
  }

  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === 'OPTIONS') {
    return handleOptions(request);
  }

  try {
    switch (path) {
      case '/generate':
        const address = await generateEmailAddress(env);
        return new Response(JSON.stringify({ address }), {
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      case '/emails':
        return getEmails(request, env);
      case '/email':
        return handleNewEmail(request, env);
      default:
        return new Response('Not found', { status: 404 });
    }
  } catch (err) {
    logError(`请求处理错误`);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      }
    });
  }
}

// 使用新的模块格式导出处理函数
export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env);
  }
};

// 保留原有的事件监听器，以兼容旧版本
addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request, event.env));
});