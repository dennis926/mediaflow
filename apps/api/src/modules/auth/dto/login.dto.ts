import { IsEmail, IsString, Length } from 'class-validator';

export class LoginDto {
  @IsEmail({}, { message: '请输入合法的邮箱地址' })
  email!: string;

  @IsString()
  @Length(6, 72, { message: '密码长度需在 6-72 位之间' })
  password!: string;
}
