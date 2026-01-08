
import { GoogleGenAI } from "@google/genai";
import { ServerItem, LaborItem } from "./types";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

export const analyzeArchitecture = async (items: ServerItem[], labors?: LaborItem[]) => {
  const prompt = `
    Bạn là một chuyên gia tư vấn dự toán dự án phần mềm chuyên nghiệp. 
    Hãy phân tích bảng tính dự toán dưới đây bao gồm cả hạ tầng và nhân sự:
    
    Hạ tầng Server:
    ${JSON.stringify(items, null, 2)}
    
    Nghiệp vụ & Nhân sự (Mandays):
    ${JSON.stringify(labors || [], null, 2)}
    
    Yêu cầu:
    1. Kiểm tra xem cấu hình hạ tầng có quá lớn hay quá nhỏ so với số lượng manday và các đầu việc không.
    2. Đánh giá rủi ro về mặt chi phí và tiến độ dựa trên các vai trò (PM, BA, Dev).
    3. Đề xuất tối ưu hóa (ví dụ: nếu dev nhiều mà hạ tầng ít, có thể thiếu môi trường staging/testing).
    4. Phản hồi bằng tiếng Việt chuyên nghiệp, ngắn gọn, súc tích.
  `;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt,
    });
    
    return response.text || "Không tìm thấy nội dung phản hồi từ AI.";
  } catch (error: any) {
    console.error("Gemini Analysis Error:", error);
    return "Không thể thực hiện phân tích dự án vào lúc này. Vui lòng thử lại sau.";
  }
};

export const predictTaskMandays = async (title: string, description: string, role: string) => {
  const prompt = `
    Bạn là một Chuyên gia Quản trị Dự án (PM) và Senior Developer.
    Hãy ước lượng số công (Mandays) cần thiết để hoàn thành công việc sau:
    
    Tiêu đề: ${title}
    Mô tả: ${description}
    Vai trò thực hiện: ${role}
    
    Yêu cầu:
    - Chỉ trả về DUY NHẤT 1 CON SỐ (có thể là số thập phân như 0.5, 1.5, 2).
    - Không giải thích thêm.
    - Nếu thông tin quá ít, hãy đưa ra con số trung bình dựa trên kinh nghiệm thực tế cho loại việc này.
  `;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt,
    });
    
    const result = response.text.trim();
    const manday = parseFloat(result);
    return isNaN(manday) ? 0 : manday;
  } catch (error) {
    console.error("AI Estimation Error:", error);
    return null;
  }
};
