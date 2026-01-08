
import { GoogleGenAI } from "@google/genai";
import { ServerItem, LaborItem } from "./types";

/**
 * Analyzes the software project architecture including infra and labors using Gemini AI.
 */
export const analyzeArchitecture = async (items: ServerItem[], labors?: LaborItem[]) => {
  // Use process.env.API_KEY directly as per guidelines
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  const prompt = `
    Bạn là một chuyên gia tư vấn dự toán dự án phần mềm chuyên nghiệp. 
    Hãy phân tích bảng tính dự toán dưới đây bao gồm cả hạ tầng và nhân sự:
    
    Hạ tầng Server:
    ${JSON.stringify(items, null, 2)}
    
    Nghiệp vụ & Nhân sự (Mandays):
    ${JSON.stringify(labors || [], null, 2)}
    
    Yêu cầu:
    1. Kiểm tra xem cấu hình hạ tầng có quá lớn hay quá nhỏ không.
    2. Đánh giá rủi ro về mặt chi phí và tiến độ.
    3. Đề xuất tối ưu hóa.
    4. Phản hồi bằng tiếng Việt chuyên nghiệp, ngắn gọn.
  `;

  try {
    const response = await ai.models.generateContent({
      // Using gemini-3-pro-preview for complex reasoning tasks
      model: 'gemini-3-pro-preview',
      contents: prompt
    });
    
    // .text is a property access as per guidelines
    return response.text || "Không tìm thấy nội dung phản hồi từ AI.";
  } catch (error: any) {
    console.error("Gemini Analysis Error:", error);
    return "Không thể thực hiện phân tích dự án vào lúc này. Vui lòng thử lại sau.";
  }
};

/**
 * Predicts mandays for a specific task based on title and description.
 */
export const predictTaskMandays = async (title: string, description: string, role: string) => {
  // Use process.env.API_KEY directly as per guidelines
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  const prompt = `
    Ước lượng số công (Mandays) cho công việc:
    Tiêu đề: ${title}
    Mô tả: ${description}
    Vai trò: ${role}
    
    Yêu cầu: Chỉ trả về duy nhất 1 con số.
  `;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt
    });
    
    // .text is a property access
    const result = (response.text || "").trim();
    const manday = parseFloat(result);
    return isNaN(manday) ? 0 : manday;
  } catch (error) {
    console.error("AI Estimation Error:", error);
    return null;
  }
};
